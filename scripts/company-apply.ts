// Usage: npm run company -- --company cba [--dry-run] [--max <n>]
//
// Crawls a company's direct careers portal and applies to matching jobs via the
// existing ATS pipeline. Resume variant is set per-search (pm / se).
//
// Companies:
//   cba  — CommBank (cba.wd3.myworkdayjobs.com/CommBank_Careers)

import 'dotenv/config';
import { chromium, Browser, BrowserContext, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { SeekPlatform } from '../lib/platforms/seek';
import { CompanyCrawler } from '../lib/crawlers/types';
import { CbaCrawler } from '../lib/crawlers/cba';
import { loadKB, saveKB } from '../lib/questions-kb';
import { logger } from '../lib/logger';
import * as tracker from '../lib/tracker';
import {
  loadApplied, saveApplied, loadBlocked,
  applyToSingleUrl,
} from '../lib/apply-utils';

// ── CRAWLER REGISTRY ──────────────────────────────────────────────────────────

const CRAWLERS: Record<string, CompanyCrawler> = {
  cba: new CbaCrawler(),
};

// ── CLI ARGS ──────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] ?? null : null;
  };
  const has = (flag: string) => args.includes(flag);
  return {
    company: get('--company') ?? process.env.COMPANY ?? 'cba',
    dryRun: has('--dry-run') || process.env.DRY_RUN === 'true',
    maxApps: Number(get('--max') ?? process.env.MAX_APPS_PER_RUN ?? 20),
    maxPerSearch: Number(process.env.MAX_APPS_PER_SEARCH ?? 10),
  };
}

const DELAY_BETWEEN_APPS_MS = 6_000;

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const runStart = Date.now();
  const runId = new Date(runStart).toISOString();

  const crawler = CRAWLERS[opts.company];
  if (!crawler) {
    logger.error(`Unknown company: "${opts.company}". Available: ${Object.keys(CRAWLERS).join(', ')}`, {});
    process.exit(1);
  }

  logger.info('company-apply starting', {
    company: opts.company,
    maxApps: opts.maxApps,
    maxPerSearch: opts.maxPerSearch,
    dryRun: opts.dryRun,
    searches: crawler.searches.map((s) => s.name),
  });

  const kb = loadKB();
  const applied = loadApplied();
  const blocked = loadBlocked();

  const interactive = process.stdin.isTTY === true;
  const browser: Browser = await chromium.launch({
    headless: !interactive,
    args: interactive ? ['--start-maximized'] : [],
  });

  // SeekPlatform.authenticate sets up the browser context + loads SEEK cookies
  // (stale cookies don't affect Workday navigation — they're scoped to seek.com.au).
  const platform = new SeekPlatform();
  const context: BrowserContext = await platform.authenticate(browser);
  const page: Page = await context.newPage();

  const seekPlatform = platform as SeekPlatform & { readBaseCoverLetter?: () => string };
  const baseCoverLetter = seekPlatform.readBaseCoverLetter?.() ?? '';

  let total = 0;
  let runFailed = false;

  try {
    for (const search of crawler.searches) {
      if (total >= opts.maxApps) {
        logger.info('hit maxApps — stopping', { total, cap: opts.maxApps });
        break;
      }

      logger.info('crawling search', { name: search.name, variant: search.resumeVariant });
      const listingPage = await context.newPage();
      const links = await crawler.getJobLinks(listingPage, search.url);
      await listingPage.close();

      logger.info('jobs found', { name: search.name, count: links.length });
      let countThisSearch = 0;

      for (const { url, title, jobId } of links) {
        if (total >= opts.maxApps) break;
        if (countThisSearch >= opts.maxPerSearch) {
          logger.info('hit maxPerSearch', { name: search.name, cap: opts.maxPerSearch });
          break;
        }
        if (applied.has(jobId)) { logger.debug('already applied', { jobId, title }); continue; }
        if (blocked.has(jobId)) { logger.debug('blocked', { jobId, title }); continue; }

        logger.info('applying', { company: opts.company, search: search.name, jobId, title });

        const result = await applyToSingleUrl(platform, page, context, url, kb, baseCoverLetter, opts.dryRun, runId);

        // Only mark the ledger when the apply actually landed. Bug fixed
        // 2026-06-02: previously every visited job was recorded as applied
        // regardless of outcome (see LEARNINGS.md). CSV side-effects already
        // happened inside applyToSingleUrl via tracker.record*.
        if (!opts.dryRun && result.status === 'applied') {
          applied.add(jobId);
          saveApplied(applied);
          saveKB(kb);
        } else if (!opts.dryRun) {
          logger.info('not adding to applied ledger', { jobId, status: result.status, reason: result.reason });
        }
        total++;
        countThisSearch++;
        await page.waitForTimeout(DELAY_BETWEEN_APPS_MS);
      }
    }
  } catch (err) {
    runFailed = true;
    logger.error('company-apply crashed', {}, err);
  } finally {
    await browser.close();
    const durationSec = Math.round((Date.now() - runStart) / 1000);
    logger.info('company-apply done', { company: opts.company, applied: total, durationSec });
    if (!opts.dryRun) {
      tracker.recordRun({
        runId,
        startedAt: new Date(runStart).toISOString(),
        applied: total,
        skipped: 0,
        failed: 0,
        dryRun: false,
        status: runFailed ? 'failed' : 'success',
      });
    }
    if (runFailed) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
