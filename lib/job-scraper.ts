import { Page } from '@playwright/test';
import { JobDetails } from './platforms/types';
import { callOpenRouter } from './openrouter';
import { logger } from './logger';

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function emptyDetails(): JobDetails {
  return { title: '', company: '', description: '', location: '', salaryText: '', workType: '' };
}

function isFull(d: JobDetails): boolean {
  return !!(d.title && d.company && d.description);
}

// ── Step 1: JSON-LD JobPosting ─────────────────────────────────────────────

async function fromJsonLd(page: Page): Promise<JobDetails | null> {
  try {
    const scripts = await page.locator('script[type="application/ld+json"]').allInnerTexts();
    for (const raw of scripts) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { continue; }

      const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of candidates) {
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        const type = obj['@type'];
        const types = Array.isArray(type) ? type : [type];
        if (!types.includes('JobPosting')) continue;

        const loc = obj['jobLocation'] as Record<string, unknown> | undefined;
        const addr = loc?.['address'] as Record<string, unknown> | undefined;
        const locationArr = Array.isArray(loc) ? loc : undefined;
        const locationStr = addr
          ? String(addr['addressLocality'] ?? addr['addressRegion'] ?? '')
          : locationArr
            ? String((locationArr[0] as Record<string, unknown>)?.['address'] ?? '')
            : String(loc ?? '');

        const salary = obj['baseSalary'] as Record<string, unknown> | undefined;
        const salaryVal = salary?.['value'] as Record<string, unknown> | undefined;
        const salaryText = salaryVal?.['value']
          ? `${salaryVal['value']} ${obj['salaryCurrency'] ?? ''}`
          : salary
            ? JSON.stringify(salary)
            : '';

        const employment = obj['employmentType'];
        const workType = Array.isArray(employment) ? employment.join('/') : String(employment ?? '');

        const hiring = obj['hiringOrganization'];
        const company = hiring && typeof hiring === 'object'
          ? String((hiring as Record<string, unknown>)['name'] ?? '')
          : String(hiring ?? '');

        const d: JobDetails = {
          title: String(obj['title'] ?? ''),
          company,
          description: truncate(stripHtml(String(obj['description'] ?? '')), 8000),
          location: locationStr,
          salaryText,
          workType,
        };

        if (isFull(d)) return d;
      }
    }
  } catch (err) {
    logger.warn('job-scraper: json-ld failed', { error: String(err) });
  }
  return null;
}

// ── Step 2: Host-specific selectors ───────────────────────────────────────

async function getText(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().innerText({ timeout: 3000 }).catch(() => '');
}

async function fromLinkedIn(page: Page): Promise<JobDetails> {
  logger.warn('job-scraper: linkedin scraping may be blocked without auth', {});
  return {
    title: await getText(page, '.top-card-layout__title, h1.t-24'),
    company: await getText(page, '.topcard__org-name-link, .topcard__flavor--bullet:first-child'),
    description: truncate(await getText(page, '.show-more-less-html__markup'), 8000),
    location: await getText(page, '.topcard__flavor--bullet:last-child, .topcard__flavor:last-of-type'),
    salaryText: '',
    workType: '',
  };
}

async function fromWorkday(page: Page): Promise<JobDetails> {
  const company = await getText(page, '[data-automation-id="jobPostingCompany"]')
    || (await page.title()).split('|')[1]?.trim() || '';
  return {
    title: await getText(page, '[data-automation-id="jobPostingHeader"]'),
    company,
    description: truncate(await getText(page, '[data-automation-id="jobPostingDescription"]'), 8000),
    location: await getText(page, '[data-automation-id="locations"]'),
    salaryText: '',
    workType: '',
  };
}

async function fromGreenhouse(page: Page): Promise<JobDetails> {
  return {
    title: await getText(page, '.app-title, h1'),
    company: await getText(page, '.company-name, [itemprop="hiringOrganization"]'),
    description: truncate(await getText(page, '#content'), 8000),
    location: await getText(page, '.location'),
    salaryText: '',
    workType: '',
  };
}

async function fromLever(page: Page): Promise<JobDetails> {
  const title = await getText(page, '.posting-headline h2');
  const company = await getText(page, '.main-header-text')
    || (await page.title()).split('at ')[1]?.trim() || '';
  return {
    title,
    company,
    description: truncate(await getText(page, '.section-wrapper.page-full-width'), 8000),
    location: await getText(page, '.posting-categories .location'),
    salaryText: '',
    workType: '',
  };
}

async function fromHostSelectors(page: Page, url: string): Promise<JobDetails | null> {
  try {
    const host = new URL(url).hostname.toLowerCase();
    let d: JobDetails;

    if (host.includes('linkedin.com')) {
      d = await fromLinkedIn(page);
    } else if (host.includes('myworkdayjobs.com') || host.includes('myworkdaysite.com')) {
      d = await fromWorkday(page);
    } else if (host.includes('greenhouse.io')) {
      d = await fromGreenhouse(page);
    } else if (host.includes('lever.co')) {
      d = await fromLever(page);
    } else {
      return null;
    }

    return (d.title && d.description) ? d : null;
  } catch (err) {
    logger.warn('job-scraper: host-selectors failed', { url, error: String(err) });
    return null;
  }
}

// ── Step 3: LLM HTML fallback ─────────────────────────────────────────────

async function fromLlm(page: Page, url: string): Promise<JobDetails | null> {
  try {
    let html = await page.content();
    html = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
    html = truncate(html, 50000);

    const response = await callOpenRouter(
      `Extract the job posting details from this HTML. Return ONLY a JSON object with these exact keys: title, company, description (plain text max 8000 chars), location, salaryText, workType. Use empty string for any missing fields. No markdown, no explanation.\n\n${html}`,
    );

    const raw = response.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(raw) as Partial<JobDetails>;
    const d: JobDetails = {
      title: String(parsed.title ?? ''),
      company: String(parsed.company ?? ''),
      description: truncate(String(parsed.description ?? ''), 8000),
      location: String(parsed.location ?? ''),
      salaryText: String(parsed.salaryText ?? ''),
      workType: String(parsed.workType ?? ''),
    };

    logger.info('job-scraper: llm extraction done', { url: url.slice(0, 80), title: d.title });
    return d.title ? d : null;
  } catch (err) {
    logger.warn('job-scraper: llm fallback failed', { url, error: String(err) });
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function scrapeJobDetails(page: Page, url: string): Promise<JobDetails> {
  try {
    const jsonLd = await fromJsonLd(page);
    if (jsonLd) return jsonLd;

    const hostResult = await fromHostSelectors(page, url);
    if (hostResult) return hostResult;

    const llmResult = await fromLlm(page, url);
    if (llmResult) return llmResult;

    logger.warn('job-scraper: all strategies exhausted — returning empty details', { url: url.slice(0, 80) });
  } catch (err) {
    logger.warn('job-scraper: unexpected error', { url, error: String(err) });
  }
  return emptyDetails();
}
