import { Browser, BrowserContext, Page } from '@playwright/test';
import { JobPlatform, JobDetails, SearchConfig, ApplyConfig, ApplyResult } from './types';
import { getOrCreateIndeedSession, saveIndeedSession, isIndeedSessionExpired } from '../indeed-session';
import { scrapeJobDetails } from '../job-scraper';
import { applyViaATS, detectATS } from '../ats/index';
import { logger } from '../logger';

const BASE_PARAMS = 'salaryType=yearly&salary=%24120%2C000%2B&fromage=7&sort=date';

const INDEED_SEARCHES: SearchConfig[] = [
  {
    name: 'PM Sydney (Indeed)',
    url: `https://au.indeed.com/jobs?q=project+manager&l=Sydney+NSW&${BASE_PARAMS}`,
    resumeVariant: 'pm',
  },
  {
    name: 'PM Brisbane (Indeed)',
    url: `https://au.indeed.com/jobs?q=project+manager&l=Brisbane+QLD&${BASE_PARAMS}`,
    resumeVariant: 'pm',
  },
  {
    name: 'Delivery Manager Sydney (Indeed)',
    url: `https://au.indeed.com/jobs?q=delivery+manager&l=Sydney+NSW&${BASE_PARAMS}`,
    resumeVariant: 'pm',
  },
  {
    name: 'SE Sydney (Indeed)',
    url: `https://au.indeed.com/jobs?q=software+engineer&l=Sydney+NSW&${BASE_PARAMS}`,
    resumeVariant: 'se',
  },
  {
    name: 'AI Engineer AU (Indeed)',
    url: `https://au.indeed.com/jobs?q=ai+engineer&l=Australia&radius=0&${BASE_PARAMS}`,
    resumeVariant: 'se',
  },
];

export class IndeedPlatform implements JobPlatform {
  readonly name = 'indeed';
  readonly searches: SearchConfig[] = INDEED_SEARCHES;

  async authenticate(browser: Browser): Promise<BrowserContext> {
    return getOrCreateIndeedSession(browser);
  }

  async persistSession(context: BrowserContext): Promise<void> {
    await saveIndeedSession(context);
  }

  async isSessionExpired(page: Page): Promise<boolean> {
    return isIndeedSessionExpired(page);
  }

  async getJobLinks(page: Page): Promise<string[]> {
    // Scroll twice to trigger lazy-loaded cards
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(800);
    }

    const jkValues = await page.evaluate(() => {
      const cards = document.querySelectorAll<HTMLElement>(
        'a.jcs-JobTitle[data-jk], h2.jobTitle a[data-jk], [data-jk]'
      );
      const jks = new Set<string>();
      cards.forEach((el) => {
        const jk = el.getAttribute('data-jk');
        if (jk) jks.add(jk);
      });
      return [...jks];
    });

    const links = jkValues.map((jk) => `https://au.indeed.com/viewjob?jk=${jk}`);
    logger.info('indeed: job links collected', { count: links.length });
    return links;
  }

  async getJobDetails(page: Page): Promise<JobDetails> {
    const url = page.url();

    const getText = async (selector: string): Promise<string> =>
      page.locator(selector).first().innerText({ timeout: 3000 }).catch(() => '');

    const title = await getText(
      'h1[data-testid="jobsearch-JobInfoHeader-title"] span, h1[data-testid="jobsearch-JobInfoHeader-title"]'
    );
    const company = await getText(
      '[data-testid="inlineHeader-companyName"] a, [data-testid="inlineHeader-companyName"]'
    );
    const location = await getText(
      '[data-testid="inlineHeader-companyLocation"] div, [data-testid="jobsearch-JobInfoHeader-companyLocation"]'
    );
    const salaryText = await getText(
      '[id="salaryInfoAndJobType"] span, [data-testid="attribute_snippet_compensation"]'
    );
    const description = (await getText('#jobDescriptionText')).slice(0, 8000);

    if (title && description) {
      return { title, company, location, salaryText, description, workType: '' };
    }

    // Fallback: universal scraper handles JSON-LD + LLM
    logger.info('indeed: primary selectors incomplete — falling back to scrapeJobDetails', { url: url.slice(0, 80) });
    return scrapeJobDetails(page, url);
  }

  async applyToJob(
    page: Page,
    _context: BrowserContext,
    details: JobDetails,
    config: ApplyConfig,
  ): Promise<ApplyResult> {
    const url = page.url();

    // Detect apply button type
    const easyApplyBtn = page.locator(
      'button[id="indeedApplyButton"], [data-testid="indeedApplyButton"]'
    );
    const externalBtn = page.locator(
      'a[aria-label*="Apply on company site" i], button:has-text("Apply on company site")'
    );

    const hasEasyApply = await easyApplyBtn.first().isVisible({ timeout: 3000 }).catch(() => false);

    if (hasEasyApply) {
      // Cross-origin iframe — deferred to Phase 6.5
      logger.info('indeed: easy apply detected — skipping (Phase 6.5)', { title: details.title });
      return { success: false, skipReason: 'indeed-easy-apply-not-implemented' };
    }

    const hasExternal = await externalBtn.first().isVisible({ timeout: 3000 }).catch(() => false);

    if (!hasExternal) {
      logger.info('indeed: no recognised apply button — skipping', { url: url.slice(0, 80) });
      return { success: false, skipReason: 'no-apply-button-found' };
    }

    // External apply: capture destination URL without navigating the main page away
    let externalUrl: string | null = null;
    try {
      const [popup] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 5000 }),
        externalBtn.first().click(),
      ]);
      externalUrl = popup.url();
      await popup.close();
    } catch {
      // Some external links navigate in the same tab
      try {
        await externalBtn.first().click();
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 });
        externalUrl = page.url();
      } catch (err) {
        logger.warn('indeed: could not resolve external apply URL', { error: String(err) });
        return { success: false, failureReason: 'external-url-resolution-failed', externalUrl: undefined };
      }
    }

    if (!externalUrl || externalUrl === url) {
      return { success: false, skipReason: 'external-url-unchanged' };
    }

    const provider = detectATS(externalUrl);
    if (!provider) {
      logger.info('indeed: external apply — ATS unknown, flagging for review', { externalUrl: externalUrl.slice(0, 80) });
      return {
        success: false,
        requiresManualReview: true,
        externalUrl,
        atsProvider: 'unknown',
        skipReason: 'ats-unknown',
      };
    }

    logger.info('indeed: routing to ATS handler', { provider, externalUrl: externalUrl.slice(0, 80) });

    // Navigate to the external ATS page (popup was closed above)
    await page.goto(externalUrl);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    const { result, provider: resolvedProvider } = await applyViaATS(
      page, externalUrl, details, config, null, config.baseCoverLetter
    );

    return {
      success: result.status === 'applied',
      skipReason: result.status === 'skipped' ? result.reason : undefined,
      failureReason: result.status === 'failed' ? result.reason : undefined,
      requiresManualReview: result.status === 'needs_manual_review',
      atsProvider: resolvedProvider ?? undefined,
      externalUrl,
    };
  }
}
