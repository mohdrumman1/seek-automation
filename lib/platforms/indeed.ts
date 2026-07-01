import { Browser, BrowserContext, Page } from '@playwright/test';
import { JobPlatform, JobDetails, SearchConfig, ApplyConfig, ApplyResult } from './types';
import { getOrCreateIndeedSession, saveIndeedSession, isIndeedSessionExpired } from '../indeed-session';
import { scrapeJobDetails } from '../job-scraper';
import { applyViaATS, detectATS } from '../ats/index';
import { tailorCoverLetter } from '../openrouter';
import { tailorResume, TailoredContent } from '../resume-tailor';
import { generateTailoredDocx } from '../resume-generator';
import { resolveResumeVariant } from '../resume-selector';
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

    const collect = async () => page.evaluate(() => {
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

    let jkValues = await collect();

    // Diagnostic: if zero links, capture page state to figure out what Indeed
    // actually served (captcha, empty SERP, redirect, IP block, etc.). Without
    // this we have no way to know why CI runs collect 0 every time.
    if (jkValues.length === 0) {
      try {
        const diag = await page.evaluate(() => ({
          title: document.title,
          url: location.href,
          bodyLen: document.body?.innerText?.length ?? 0,
          h1: document.querySelector('h1')?.textContent?.slice(0, 200) ?? null,
          hasCaptcha: /captcha|verify you are human|just a moment|cf-challenge/i.test(
            document.body?.innerText ?? ''
          ),
          hasNoResults: /no jobs found|did not match any jobs|0 jobs/i.test(
            document.body?.innerText ?? ''
          ),
          bodySnippet: (document.body?.innerText ?? '').slice(0, 400),
        }));
        logger.warn('indeed: zero links collected — page diagnostic', diag);
        const fs = await import('fs');
        const path = await import('path');
        const dir = path.resolve(process.cwd(), 'screenshots/indeed-debug');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        await page
          .screenshot({ path: path.join(dir, `zero-links-${ts}.png`), fullPage: false })
          .catch(() => {});
      } catch (err) {
        logger.warn('indeed: diagnostic capture failed', { error: String(err) });
      }
    }

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

    // Detect apply button type — check external FIRST so that jobs with both
    // Easy Apply and an external button use the external (ATS) path.
    const externalBtn = page.locator(
      'a[aria-label*="Apply on company site" i], button:has-text("Apply on company site"), ' +
      'a:has-text("Apply on company website"), a[href*="apply"][target="_blank"]'
    );
    const easyApplyBtn = page.locator(
      'button[id="indeedApplyButton"], [data-testid="indeedApplyButton"]'
    );

    const hasExternal = await externalBtn.first().isVisible({ timeout: 3000 }).catch(() => false);

    if (!hasExternal) {
      const hasEasyApply = await easyApplyBtn.first().isVisible({ timeout: 3000 }).catch(() => false);
      if (hasEasyApply) {
        // Cross-origin iframe — deferred to Phase 6.5.
        logger.info('indeed: easy apply only — skipping (Phase 6.5)', { title: details.title });
        return { success: false, skipReason: 'indeed-easy-apply-not-implemented' };
      }
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

    // Tailor cover letter and resume before navigating to external ATS
    const atsCoverLetter = await tailorCoverLetter(
      config.baseCoverLetter, details.title, details.company, details.description
    ).catch(() => config.baseCoverLetter);

    let atsResumePath: string | null = null;
    if (process.env.RESUME_TAILORING_ENABLED === 'true') {
      const variant = resolveResumeVariant(details.title, config.searchName) ?? config.resumeVariant;
      const jobId = externalUrl.match(/(\d{5,})/)?.[1] ?? Date.now().toString();
      const tailored = await tailorResume(
        variant, details.title, details.company, details.description, externalUrl
      ).catch(() => null);
      if (tailored) {
        atsResumePath = await generateTailoredDocx(
          tailored as TailoredContent, jobId, details.company
        ).catch(() => null);
      }
    }

    // Navigate to the external ATS page (popup was closed above).
    // External ATS URLs are the slowest and most timeout-prone — never crash on nav.
    try {
      await page.goto(externalUrl, { timeout: 60_000, waitUntil: 'domcontentloaded' });
    } catch (err) {
      logger.warn('indeed external ATS nav failed', { externalUrl, error: String(err) });
      return { success: false, failureReason: 'nav_timeout', externalUrl };
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    const { result, provider: resolvedProvider } = await applyViaATS(
      page, externalUrl, details, config, atsResumePath, atsCoverLetter
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
