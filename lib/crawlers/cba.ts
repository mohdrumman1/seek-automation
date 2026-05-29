import { Page } from '@playwright/test';
import { CompanyCrawler, CrawlerJobLink, CrawlerSearch } from './types';
import { logger } from '../logger';

const CBA_SEARCHES: CrawlerSearch[] = [
  {
    name: 'cba-pm',
    url: 'https://cba.wd3.myworkdayjobs.com/CommBank_Careers?q=project%20manager&locationCountry=d903bb3fedad45039383f6de334ad4db',
    resumeVariant: 'pm',
  },
  {
    name: 'cba-se',
    url: 'https://cba.wd3.myworkdayjobs.com/CommBank_Careers?q=software%20engineer&locationCountry=d903bb3fedad45039383f6de334ad4db',
    resumeVariant: 'se',
  },
];

const CBA_BASE = 'https://cba.wd3.myworkdayjobs.com';

export class CbaCrawler implements CompanyCrawler {
  name = 'cba';
  searches = CBA_SEARCHES;

  async getJobLinks(page: Page, searchUrl: string): Promise<CrawlerJobLink[]> {
    await page.goto(searchUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);

    // Workday lazy-loads listings in batches; click "Load More" until exhausted.
    for (let i = 0; i < 20; i++) {
      const loadMore = page.locator(
        'button:has-text("Load More"), [data-automation-id="loadMoreButton"]'
      ).first();
      if (await loadMore.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await loadMore.click().catch(() => {});
        await page.waitForTimeout(2_000);
      } else {
        // Try a scroll to trigger lazy-load, then re-check
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1_500);
        if (!(await loadMore.isVisible({ timeout: 1_000 }).catch(() => false))) break;
      }
    }

    // Workday job title links use data-automation-id="jobTitle" or href containing the portal name
    const anchors = await page.locator(
      '[data-automation-id="jobTitle"], a[href*="/CommBank_Careers/job/"]'
    ).all();

    const results: CrawlerJobLink[] = [];
    const seen = new Set<string>();

    for (const a of anchors) {
      const href = await a.getAttribute('href').catch(() => null);
      const title = ((await a.textContent().catch(() => '')) ?? '').trim();
      if (!href) continue;

      const abs = href.startsWith('http') ? href : new URL(href, CBA_BASE).toString();

      // Derive a stable jobId from the Workday requisition ID embedded in the URL slug
      // e.g. ".../Senior-Project-Manager_R-0000123456" → "R-0000123456"
      const reqMatch = abs.match(/_(R-[\w]+)\s*$/i);
      const jobId = reqMatch ? reqMatch[1] : (abs.split('/').pop() ?? abs);

      if (seen.has(jobId)) continue;
      seen.add(jobId);

      results.push({ url: abs, title, jobId });
    }

    logger.info('cba: job links scraped', { search: searchUrl.slice(-60), total: results.length });
    return results;
  }
}
