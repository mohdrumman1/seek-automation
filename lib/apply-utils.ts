import * as fs from 'fs';
import * as path from 'path';
import { Page, BrowserContext } from '@playwright/test';
import { JobPlatform, JobDetails, ApplyResult } from './platforms/types';
import { resolveResumeVariant } from './resume-selector';
import { tailorCoverLetter } from './openrouter';
import { tailorResume, TailoredContent } from './resume-tailor';
import { generateTailoredDocx } from './resume-generator';
import { scrapeJobDetails } from './job-scraper';
import { applyViaATS, detectATS } from './ats/index';
import { loadKB } from './questions-kb';
import { logger } from './logger';
import * as tracker from './tracker';
import { isCircuitOpen } from './run-health';

export const APPLIED_LOG = path.resolve(__dirname, '../data/applied_jobs.json');
export const BLOCKED_LOG = path.resolve(__dirname, '../data/blocked_jobs.json');

export function loadApplied(): Set<string> {
  if (fs.existsSync(APPLIED_LOG)) {
    return new Set(JSON.parse(fs.readFileSync(APPLIED_LOG, 'utf-8')) as string[]);
  }
  return new Set();
}

export function saveApplied(applied: Set<string>): void {
  fs.writeFileSync(APPLIED_LOG, JSON.stringify([...applied]), 'utf-8');
}

export function loadBlocked(): Set<string> {
  if (fs.existsSync(BLOCKED_LOG)) {
    return new Set(JSON.parse(fs.readFileSync(BLOCKED_LOG, 'utf-8')) as string[]);
  }
  return new Set();
}

export function saveBlocked(blocked: Set<string>): void {
  fs.writeFileSync(BLOCKED_LOG, JSON.stringify([...blocked]), 'utf-8');
}

export const TRIVIAL_SKIP_REASONS = new Set([
  'location_out_of_region',
  'already_applied',
  'job_no_longer_advertised',
  'security_clearance_required',
  'ats_pageup_captcha',
]);

export function isSeekUrl(u: string): boolean {
  try { return new URL(u).hostname.toLowerCase().includes('seek.com'); } catch { return false; }
}

export function isWorkdayApplyForm(u: string): boolean {
  try {
    const p = new URL(u).pathname.toLowerCase();
    return p.includes('/apply/') || /\/job\/[^/]+\/apply/.test(p);
  } catch { return false; }
}

export interface ApplyToSingleUrlResult {
  success: boolean;
  status: 'applied' | 'skipped' | 'failed' | 'needs_manual_review';
  reason?: string;
}

export async function applyToSingleUrl(
  platform: JobPlatform,
  page: Page,
  context: BrowserContext,
  url: string,
  kb: ReturnType<typeof loadKB>,
  baseCoverLetter: string,
  dryRun: boolean,
  runId: string,
  beforeSubmit?: () => Promise<boolean>,
): Promise<ApplyToSingleUrlResult> {
  try {
    await page.goto(url, { timeout: 60_000, waitUntil: 'domcontentloaded' });
  } catch (err) {
    logger.warn('single-url nav failed', { url, error: String(err) });
    return { success: false, status: 'failed', reason: 'nav_timeout' };
  }
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
  } else if (atsProvider) {
    routeMode = 'ats-listing';
    details = await scrapeJobDetails(page, url);
  } else {
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
      beforeSubmit,
    });
  } else {
    // OpenRouter circuit breaker open — AI is sustained-down for this run.
    // Skip and let the next scheduled run retry rather than submitting an
    // untailored base-template application.
    if (isCircuitOpen()) {
      logger.warn('single-url: openrouter circuit open — skipping', { url: applyUrl.slice(0, 80) });
      return { success: false, status: 'skipped', reason: 'openrouter_circuit_open' };
    }

    const variant = resolveResumeVariant(details.title, 'manual');
    const config = { resumeVariant: variant, searchName: 'manual', baseCoverLetter, kb, beforeSubmit };
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

  // Propagate the outcome to the caller so it can decide whether to write to
  // the applied_jobs.json ledger. CSV side-effects already happened above via
  // tracker.record*; callers must NOT duplicate those writes.
  const status: ApplyToSingleUrlResult['status'] = result.success
    ? 'applied'
    : result.requiresManualReview
      ? 'needs_manual_review'
      : result.skipReason
        ? 'skipped'
        : 'failed';
  return {
    success: result.success,
    status,
    reason: result.skipReason ?? result.failureReason,
  };
}
