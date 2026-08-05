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
import { CbaCrawler, preAuthCba } from '../lib/crawlers/cba';
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

  // Phase 10 shift 2026-07-19: pre-authenticate ONCE on the Workday search page
  // instead of fighting the sign-in modal per-job inside lib/ats/workday.ts.
  // Workday session cookies live on the browser context; every downstream Apply
  // click then sees an active session and skips the sign-in wall entirely.
  // The workday.ts sign-in path stays as a per-job fallback for the rare case
  // where the session drops mid-run. If pre-auth fails, abort — proceeding
  // would just replay the per-job sign-in loop we're trying to escape.
  if (opts.company === 'cba' && !opts.dryRun) {
    const wdEmail = process.env.SEEK_EMAIL ?? 'mohdrumman1@gmail.com';
    const wdPassword = process.env.WORKDAY_PASSWORD ?? '';
    if (!wdPassword) {
      logger.error('cba: WORKDAY_PASSWORD not set — cannot pre-authenticate, aborting run', {});
      await browser.close();
      process.exit(1);
    }
    const preAuthed = await preAuthCba(page, wdEmail, wdPassword);
    if (!preAuthed) {
      logger.error('cba: pre-authentication failed — aborting run (see prior "cba: pre-auth" warnings for reason)', {});
      await browser.close();
      process.exit(1);
    }
  }

  let applied_count = 0;
  let skipped_count = 0;
  let failed_count = 0;
  let runFailed = false;

  try {
    for (const search of crawler.searches) {
      const attempted = applied_count + skipped_count + failed_count;
      if (attempted >= opts.maxApps) {
        logger.info('hit maxApps — stopping', { attempted, cap: opts.maxApps });
        break;
      }

      logger.info('crawling search', { name: search.name, variant: search.resumeVariant });
      const listingPage = await context.newPage();
      const links = await crawler.getJobLinks(listingPage, search.url);
      await listingPage.close();

      logger.info('jobs found', { name: search.name, count: links.length });
      let countThisSearch = 0;

      for (const { url, title, jobId } of links) {
        if ((applied_count + skipped_count + failed_count) >= opts.maxApps) break;
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

        // 2026-07-19: was `total++` regardless of outcome, then logged as
        // `applied:${total}` — CI showed "applied:20" when 0/20 actually
        // applied. Bucket needs_manual_review under skipped (not a hard fail).
        if (result.status === 'applied') applied_count++;
        else if (result.status === 'failed') failed_count++;
        else skipped_count++; // 'skipped' or 'needs_manual_review'

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
    logger.info(
      `company-apply: ${opts.company} done — applied:${applied_count} skipped:${skipped_count} failed:${failed_count}`,
      { company: opts.company, applied: applied_count, skipped: skipped_count, failed: failed_count, durationSec }
    );
    if (!opts.dryRun) {
      tracker.recordRun({
        runId,
        startedAt: new Date(runStart).toISOString(),
        applied: applied_count,
        skipped: skipped_count,
        failed: failed_count,
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
