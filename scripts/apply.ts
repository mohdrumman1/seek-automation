// Usage: npm run seek (or: ts-node scripts/apply.ts [options])
//
// Options:
//   --platform <name>    seek (default; indeed/glassdoor in Phase 6)
//   --url <job-url>      apply to a single job URL and exit (useful for testing)
//   --dry-run            fill everything, never submit, never write CSVs
//   --no-submit          same as --dry-run (alias)
//   --max <n>            override MAX_APPS_PER_RUN
//
// This script is platform-agnostic. All SEEK-specific logic lives in
// lib/platforms/seek.ts. To add a new platform, implement JobPlatform and
// add it to the registry below.

import 'dotenv/config';
import { chromium, Browser, BrowserContext, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { JobPlatform, JobDetails, ApplyResult } from '../lib/platforms/types';
import { SeekPlatform } from '../lib/platforms/seek';
import { IndeedPlatform } from '../lib/platforms/indeed';
import { resolveResumeVariant } from '../lib/resume-selector';
import { tailorCoverLetter } from '../lib/openrouter';
import { tailorResume, TailoredContent } from '../lib/resume-tailor';
import { generateTailoredDocx } from '../lib/resume-generator';
import { scrapeJobDetails } from '../lib/job-scraper';
import { applyViaATS, detectATS } from '../lib/ats/index';
import { loadKB, saveKB } from '../lib/questions-kb';
import { logger } from '../lib/logger';
import * as tracker from '../lib/tracker';

// ── PLATFORM REGISTRY ─────────────────────────────────────────────────────────

const PLATFORMS: Record<string, () => JobPlatform> = {
  seek: () => new SeekPlatform(),
  indeed: () => new IndeedPlatform(),
};

// ── CLI ARG PARSING ───────────────────────────────────────────────────────────

function parseArgs(): {
  platform: string;
  singleUrl: string | null;
  dryRun: boolean;
  maxAppsPerRun: number;
  maxAppsPerSearch: number;
} {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : null;
  };
  const has = (flag: string) => args.includes(flag);

  return {
    platform: get('--platform') ?? process.env.PLATFORM ?? 'seek',
    singleUrl: get('--url') ?? null,
    dryRun: has('--dry-run') || has('--no-submit') || process.env.DRY_RUN === 'true',
    maxAppsPerRun: Number(get('--max') ?? process.env.MAX_APPS_PER_RUN ?? 20),
    maxAppsPerSearch: Number(process.env.MAX_APPS_PER_SEARCH ?? 10),
  };
}

// ── APPLIED JOBS LOG ──────────────────────────────────────────────────────────

const APPLIED_LOG = path.resolve(__dirname, '../data/applied_jobs.json');
// Jobs that can never be auto-applied (e.g. SEEK profile incomplete, manual-only) —
// stored separately so applied_jobs stays semantically correct.
const BLOCKED_LOG = path.resolve(__dirname, '../data/blocked_jobs.json');

function loadApplied(): Set<string> {
  if (fs.existsSync(APPLIED_LOG)) {
    return new Set(JSON.parse(fs.readFileSync(APPLIED_LOG, 'utf-8')) as string[]);
  }
  return new Set();
}

function saveApplied(applied: Set<string>): void {
  fs.writeFileSync(APPLIED_LOG, JSON.stringify([...applied]), 'utf-8');
}

function loadBlocked(): Set<string> {
  if (fs.existsSync(BLOCKED_LOG)) {
    return new Set(JSON.parse(fs.readFileSync(BLOCKED_LOG, 'utf-8')) as string[]);
  }
  return new Set();
}

// These skips are pre-filters (location, already-applied, expired) — they are recorded
// in the CSV for analysis but do NOT count toward the reported `skipped` summary stat
// so the number reflects meaningful application attempts, not housekeeping noise.
const TRIVIAL_SKIP_REASONS = new Set([
  'location_out_of_region',
  'already_applied',
  'job_no_longer_advertised',
  'security_clearance_required',
]);

function saveBlocked(blocked: Set<string>): void {
  fs.writeFileSync(BLOCKED_LOG, JSON.stringify([...blocked]), 'utf-8');
}

// ── MAIN LOOP (platform-agnostic) ─────────────────────────────────────────────

const DELAY_BETWEEN_APPS_MS = 6_000;
const CIRCUIT_BREAKER_THRESHOLD = 3;

function isSeekUrl(u: string): boolean {
  try { return new URL(u).hostname.toLowerCase().includes('seek.com'); } catch { return false; }
}

// Workday apply forms have /apply/ or /job/ in the path; listing pages use /jobdetail/ or /jobs/
function isWorkdayApplyForm(u: string): boolean {
  try {
    const p = new URL(u).pathname.toLowerCase();
    return p.includes('/apply/') || /\/job\/[^/]+\/apply/.test(p);
  } catch { return false; }
}

async function applyToSingleUrl(
  platform: JobPlatform,
  page: Page,
  context: BrowserContext,
  url: string,
  kb: ReturnType<typeof loadKB>,
  baseCoverLetter: string,
  dryRun: boolean,
  runId: string,
): Promise<void> {
  await page.goto(url);
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});

  const emptyDetails: JobDetails = { title: '', company: '', description: '', location: '', salaryText: '', workType: '' };
  let details: JobDetails = { ...emptyDetails };
  let routeMode: 'seek' | 'ats-form' | 'ats-listing' | 'unknown' = 'unknown';
  let applyUrl = url;

  const atsProvider = detectATS(url);

  if (isSeekUrl(url)) {
    routeMode = 'seek';
    try { details = await platform.getJobDetails(page); } catch {}
  } else if (atsProvider === 'workday' && isWorkdayApplyForm(url)) {
    routeMode = 'ats-form';
    // Page is already the application form — no listing to scrape
  } else if (atsProvider) {
    routeMode = 'ats-listing';
    details = await scrapeJobDetails(page, url);
  } else {
    // Unknown site — scrape listing, then try to find and follow an Apply link
    details = await scrapeJobDetails(page, url);
    try {
      const applyHref = await page
        .locator('a:has-text("Apply"), a[href*="apply" i]')
        .first()
        .getAttribute('href', { timeout: 3000 });
      if (applyHref) {
        const abs = new URL(applyHref, url).toString();
        if (detectATS(abs)) {
          applyUrl = abs;
          await page.goto(abs);
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
        }
      }
    } catch {}
    routeMode = 'unknown';
  }

  logger.info('single-url mode', { routeMode, atsProvider, title: details.title || '(no title)', url: applyUrl.slice(0, 80) });
  console.log(`Single URL mode [${routeMode}]: ${details.title || applyUrl}`);

  let result: ApplyResult;

  if (routeMode === 'seek') {
    result = await platform.applyToJob(page, context, details, {
      resumeVariant: resolveResumeVariant(details.title, 'manual'),
      searchName: 'manual',
      baseCoverLetter,
      kb,
    });
  } else {
    // Non-SEEK path: tailor cover letter + resume, then call ATS handler directly
    const variant = resolveResumeVariant(details.title, 'manual');
    const config = { resumeVariant: variant, searchName: 'manual', baseCoverLetter, kb };
    const jobId = tracker.deriveJobId(applyUrl);

    let coverLetter = baseCoverLetter;
    let resumePath: string | null = null;

    if (details.title) {
      try {
        coverLetter = await tailorCoverLetter(baseCoverLetter, details.title, details.company, details.description);
      } catch (err) {
        logger.warn('single-url: cover letter tailor failed — using base', { error: String(err) });
      }
      try {
        const tailored = await tailorResume(variant, details.title, details.company, details.description, applyUrl);
        if (tailored) {
          resumePath = await generateTailoredDocx(tailored as TailoredContent, jobId, details.company).catch(() => null);
        }
      } catch (err) {
        logger.warn('single-url: resume tailor failed — no tailored resume', { error: String(err) });
      }
    }

    const { result: atsResult, provider } = await applyViaATS(page, applyUrl, details, config, resumePath, coverLetter);
    result = {
      success: atsResult.status === 'applied',
      skipReason: atsResult.status === 'skipped' ? atsResult.reason : undefined,
      failureReason: atsResult.status === 'failed' ? atsResult.reason : undefined,
      requiresManualReview: atsResult.status === 'needs_manual_review',
      atsProvider: provider ?? undefined,
      externalUrl: applyUrl !== url ? applyUrl : undefined,
      variant,
    };
  }

  console.log(result.success ? '  Applied!' : `  Not applied — ${result.skipReason ?? result.failureReason ?? 'unknown'}`);
  console.log(`\n===== RESULT: ${result.success ? 'APPLIED' : 'NOT APPLIED'} — ${details.title || url} @ ${details.company || '?'} =====\n`);
  if (!result.success && result.requiresManualReview) {
    console.log(`  Manual review required: ${result.failureReason}`);
  }

  if (!dryRun) {
    const jobId = tracker.deriveJobId(url);
    const jobMeta = {
      jobId, platform: platform.name, ...details, runId,
      atsProvider: result.atsProvider,
      externalUrl: result.externalUrl,
      routeMode,
    };
    if (result.success) {
      tracker.recordApplication({ ...jobMeta, resumeVariant: result.variant ?? 'pm' });
    } else if (result.skipReason) {
      tracker.recordSkip({ ...jobMeta, skipReason: result.skipReason });
    } else {
      tracker.recordFailure({ ...jobMeta, failureReason: result.failureReason ?? 'unknown' });
    }
  }
}

async function main() {
  const opts = parseArgs();
  const runStart = Date.now();
  const runId = new Date(runStart).toISOString();

  const factory = PLATFORMS[opts.platform];
  if (!factory) {
    logger.error(`Unknown platform: ${opts.platform}. Available: ${Object.keys(PLATFORMS).join(', ')}`, {});
    process.exit(1);
  }
  const platform = factory();

  logger.info('apply bot starting', {
    platform: platform.name,
    maxAppsPerRun: opts.maxAppsPerRun,
    maxAppsPerSearch: opts.maxAppsPerSearch,
    singleUrl: opts.singleUrl,
    dryRun: opts.dryRun,
    searches: opts.singleUrl ? [] : platform.searches.map((s) => s.name),
  });

  const kb = loadKB();
  const applied = loadApplied();
  const blocked = loadBlocked();
  // Tracks every job visited this run (any outcome) to prevent re-visiting across searches.
  const seenThisRun = new Set<string>();
  logger.info('state loaded', { previouslyApplied: applied.size, blocked: blocked.size, kbEntries: kb.length });

  const interactive = process.stdin.isTTY === true;
  const browser: Browser = await chromium.launch({
    headless: !interactive,
    args: interactive ? ['--start-maximized'] : [],
  });

  const context = await platform.authenticate(browser);
  const page = await context.newPage();

  let total = 0;
  let runSkipped = 0;      // meaningful skips (ATS not supported, unknown provider, etc.)
  let runPrefiltered = 0;  // trivial pre-filters (location, already-applied, expired) — not in summary
  let runFailedCount = 0;
  let runFailed = false;

  // SeekPlatform exposes loginAndVerify — other platforms can add their own auth step
  const seekPlatform = platform as SeekPlatform & { loginAndVerify?: (p: Page) => Promise<boolean>; readBaseCoverLetter?: () => string };
  const baseCoverLetter = seekPlatform.readBaseCoverLetter?.() ?? '';

  try {
    if (seekPlatform.loginAndVerify) {
      const ok = await seekPlatform.loginAndVerify(page);
      if (!ok) {
        runFailed = true;
        // Mark so CI doesn't overwrite the secret with stale cookies from this run
        try {
          const flagDir = path.resolve(__dirname, '../tmp');
          if (!fs.existsSync(flagDir)) fs.mkdirSync(flagDir, { recursive: true });
          fs.writeFileSync(path.join(flagDir, 'session-expired'), '');
        } catch {}
        return;
      }
    }
    await platform.persistSession(context);

    // Single-URL mode
    if (opts.singleUrl) {
      await applyToSingleUrl(platform, page, context, opts.singleUrl, kb, baseCoverLetter, opts.dryRun, runId);
      return;
    }

    // Search loop
    for (const search of platform.searches) {
      if (total >= opts.maxAppsPerRun) {
        logger.info('hit maxAppsPerRun — stopping', { total, cap: opts.maxAppsPerRun });
        break;
      }

      logger.info('search starting', { name: search.name, variant: search.resumeVariant });
      await page.goto(search.url);
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});

      const links = await platform.getJobLinks(page);
      logger.info('search jobs found', { name: search.name, count: links.length });

      let countThisSearch = 0;
      let consecutiveFailures = 0;

      for (const url of links) {
        if (total >= opts.maxAppsPerRun) { logger.info('hit maxAppsPerRun inside search', { name: search.name, total }); break; }
        if (countThisSearch >= opts.maxAppsPerSearch) { logger.info('hit maxAppsPerSearch', { name: search.name, cap: opts.maxAppsPerSearch }); break; }
        if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          logger.warn('circuit breaker tripped — moving to next search', { name: search.name, consecutiveFailures });
          break;
        }

        const jobId = url.match(/\/job\/(\d+)/)?.[1] ?? url;
        if (applied.has(jobId)) { logger.debug('already applied — skipping', { jobId }); continue; }
        if (blocked.has(jobId)) { logger.debug('permanently blocked — skipping', { jobId }); continue; }
        if (seenThisRun.has(jobId)) { logger.info('already seen this run — skipping', { jobId }); continue; }
        seenThisRun.add(jobId);

        await page.goto(url);
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});

        // Fetch details before applyToJob so tracker always has full metadata
        let details: JobDetails = { title: '', company: '', description: '', location: '', salaryText: '', workType: '' };
        try { details = await platform.getJobDetails(page); } catch {}

        let result: ApplyResult = { success: false, failureReason: 'unexpected_error' };
        try {
          result = await platform.applyToJob(page, context, details, {
            resumeVariant: search.resumeVariant,
            searchName: search.name,
            baseCoverLetter,
            kb,
          });
        } catch (e) {
          logger.error('apply threw', { jobId, url }, e);
        }

        // Close any extra tabs opened during application
        for (const p of context.pages()) {
          if (p !== page) await p.close().catch(() => {});
        }

        const jobMeta = {
          jobId,
          platform: platform.name,
          title: details.title,
          company: details.company,
          location: details.location,
          salaryText: details.salaryText,
          workType: details.workType,
          runId,
          atsProvider: result.atsProvider,
          externalUrl: result.externalUrl,
        };

        if (result.success) {
          if (!opts.dryRun) {
            applied.add(jobId);
            saveApplied(applied);
            saveKB(kb);
            tracker.recordApplication({ ...jobMeta, resumeVariant: result.variant ?? search.resumeVariant });
          }
          countThisSearch++;
          total++;
          consecutiveFailures = 0;
          logger.info('applied', { jobId, search: search.name, totalThisRun: total });
          await page.waitForTimeout(DELAY_BETWEEN_APPS_MS);
        } else if (result.skipReason) {
          if (!opts.dryRun) tracker.recordSkip({ ...jobMeta, skipReason: result.skipReason });
          // SEEK showed "You applied" — mark as applied so future runs skip immediately.
          if (result.skipReason === 'already_applied' && !opts.dryRun) {
            applied.add(jobId);
            saveApplied(applied);
          }
          // Job expired — never retry.
          if (result.skipReason === 'job_no_longer_advertised' && !opts.dryRun) {
            blocked.add(jobId);
            saveBlocked(blocked);
          }
          // Pre-filter skips (location, already-applied, expired) are noise — don't count
          // them in the summary stat so `skipped` reflects meaningful attempt failures.
          if (TRIVIAL_SKIP_REASONS.has(result.skipReason)) {
            runPrefiltered++;
          } else {
            runSkipped++;
          }
          logger.info('skip', { jobId, search: search.name, skipReason: result.skipReason });
        } else {
          if (!opts.dryRun) {
            tracker.recordFailure({
              ...jobMeta,
              failureReason: result.failureReason ?? 'unknown',
              requiresManualReview: result.requiresManualReview,
            });
          }
          // SEEK profile-incomplete jobs will never succeed — add to blocked list
          // so future runs don't waste time retrying them.
          if (result.failureReason === 'seek_profile_incomplete' && !opts.dryRun) {
            blocked.add(jobId);
            saveBlocked(blocked);
            logger.info('blocked: seek_profile_incomplete — added to blocked_jobs.json', { jobId });
          }
          runFailedCount++;
          consecutiveFailures++;
          logger.warn('apply did not succeed', { jobId, search: search.name, failureReason: result.failureReason, consecutiveFailures });
          if (result.failureReason === 'session_expired') {
            logger.error('session expired mid-run — aborting all remaining searches', {
              hint: 'Re-run `npm run seek-login` locally and update the SEEK_SESSION_COOKIES secret.',
            });
            // Write marker so the CI workflow does NOT overwrite SEEK_SESSION_COOKIES
            // with these stale cookies — preserves whatever valid cookies were set before.
            try {
              const flagDir = path.resolve(__dirname, '../tmp');
              if (!fs.existsSync(flagDir)) fs.mkdirSync(flagDir, { recursive: true });
              fs.writeFileSync(path.join(flagDir, 'session-expired'), '');
            } catch {}
            runFailed = true;
            throw new Error('session_expired');
          }
        }
      }
    }
    // ── Indeed loop (sequential, same process) ────────────────────────────────
    const indeedEnabled = process.env.INDEED_ENABLED === 'true';
    if (indeedEnabled && !opts.singleUrl && total < opts.maxAppsPerRun) {
      const indeedPlatform = new IndeedPlatform();
      const indeedContext = await indeedPlatform.authenticate(browser);
      const indeedPage = await indeedContext.newPage();
      const indeedExpired = await indeedPlatform.isSessionExpired(indeedPage);

      if (indeedExpired) {
        logger.warn('indeed session expired — skipping Indeed loop. Export cookies and set INDEED_SESSION_COOKIES.', {});
      } else {
        logger.info('indeed loop starting', { remainingBudget: opts.maxAppsPerRun - total });

        for (const search of indeedPlatform.searches) {
          if (total >= opts.maxAppsPerRun) break;

          logger.info('indeed search starting', { name: search.name });
          await indeedPage.goto(search.url);
          await indeedPage.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

          const links = await indeedPlatform.getJobLinks(indeedPage);
          logger.info('indeed search jobs found', { name: search.name, count: links.length });

          let countThisSearch = 0;
          let consecutiveFailures = 0;

          for (const jobUrl of links) {
            if (total >= opts.maxAppsPerRun) break;
            if (countThisSearch >= opts.maxAppsPerSearch) break;
            if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
              logger.warn('indeed circuit breaker — moving to next search', { name: search.name });
              break;
            }

            const jobId = tracker.deriveJobId(jobUrl);
            if (applied.has(jobId)) { logger.debug('indeed already applied — skipping', { jobId }); continue; }
            if (blocked.has(jobId)) { logger.debug('indeed permanently blocked — skipping', { jobId }); continue; }
            if (seenThisRun.has(jobId)) { logger.info('indeed already seen this run — skipping', { jobId }); continue; }
            seenThisRun.add(jobId);

            await indeedPage.goto(jobUrl);
            await indeedPage.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});

            let details: JobDetails = { title: '', company: '', description: '', location: '', salaryText: '', workType: '' };
            try { details = await indeedPlatform.getJobDetails(indeedPage); } catch {}

            let result: ApplyResult = { success: false, failureReason: 'unexpected_error' };
            try {
              result = await indeedPlatform.applyToJob(indeedPage, indeedContext, details, {
                resumeVariant: search.resumeVariant,
                searchName: search.name,
                baseCoverLetter,
                kb,
              });
            } catch (e) {
              logger.error('indeed apply threw', { jobId, jobUrl }, e);
            }

            for (const p of indeedContext.pages()) {
              if (p !== indeedPage) await p.close().catch(() => {});
            }

            const jobMeta = {
              jobId, platform: indeedPlatform.name, ...details, runId,
              atsProvider: result.atsProvider, externalUrl: result.externalUrl,
            };

            if (result.success) {
              if (!opts.dryRun) {
                applied.add(jobId);
                saveApplied(applied);
                saveKB(kb);
                tracker.recordApplication({ ...jobMeta, resumeVariant: result.variant ?? search.resumeVariant });
              }
              countThisSearch++;
              total++;
              consecutiveFailures = 0;
              logger.info('indeed applied', { jobId, search: search.name, totalThisRun: total });
              await indeedPage.waitForTimeout(DELAY_BETWEEN_APPS_MS);
            } else if (result.skipReason) {
              if (!opts.dryRun) tracker.recordSkip({ ...jobMeta, skipReason: result.skipReason });
              if (TRIVIAL_SKIP_REASONS.has(result.skipReason)) { runPrefiltered++; } else { runSkipped++; }
              logger.info('indeed skip', { jobId, skipReason: result.skipReason });
            } else {
              if (!opts.dryRun) tracker.recordFailure({ ...jobMeta, failureReason: result.failureReason ?? 'unknown', requiresManualReview: result.requiresManualReview });
              runFailedCount++;
              consecutiveFailures++;
            }
          }
        }
        await indeedPlatform.persistSession(indeedContext);
      }
      await indeedContext.close();
    }
  } catch (err) {
    runFailed = true;
    logger.error('main loop crashed', {}, err);
  } finally {
    try { await platform.persistSession(context); } catch (err) { logger.error('persistSession failed', {}, err); }
    await browser.close();
    const durationSec = Math.round((Date.now() - runStart) / 1000);
    logger.info('apply bot done', { platform: platform.name, applied: total, skipped: runSkipped, prefiltered: runPrefiltered, failed: runFailedCount, durationSec, runFailed });
    if (!opts.dryRun) {
      tracker.recordRun({
        runId,
        startedAt: new Date(runStart).toISOString(),
        applied: total,
        skipped: runSkipped,
        failed: runFailedCount,
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
