// Centralises "is this run actually healthy" signals for scripts/apply.ts.
//
// Two independent signals live here:
//   1. Zero-result streak — persisted to data/zero-result-streak.json (restored
//      across ephemeral GitHub Actions runners via actions/cache, see
//      .github/workflows/seek-apply.yml). Only escalates after 3 CONSECUTIVE
//      zero-job runs — a single quiet day is normal, not a failure signal.
//   2. OpenRouter circuit breaker — in-memory only (per-run), no persistence
//      needed. Trips after 5 consecutive AI-call failures so the run stops
//      submitting untailored applications and instead skips remaining jobs
//      for the next scheduled run to retry.
//
// Deliberately has NO imports from lib/openrouter.ts or lib/platforms/seek.ts —
// those modules import this one and call in to report events, not the other
// way around, to avoid a circular-dependency tangle.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

const STREAK_PATH = path.resolve(__dirname, '../data/zero-result-streak.json');

// A single quiet day (or two) is normal variance in the job market. Only
// treat it as a health problem — worth failing the CI job over — once it's
// happened 3 runs in a row, which points at a scraper/selector break rather
// than "no matching jobs posted today."
const ZERO_STREAK_FAIL_THRESHOLD = 3;

// After 5 consecutive OpenRouter failures, treat the AI as sustained-down
// for the rest of this run rather than retrying every job (per-call
// retry/backoff already lives in lib/openrouter.ts and is untouched by this).
const CIRCUIT_BREAKER_THRESHOLD = 5;

// ── Zero-result streak ────────────────────────────────────────────────────────

export interface ZeroResultStreak {
  consecutiveZeroRuns: number;
  lastRunTimestamp: string;
}

export interface SearchResult {
  searchName: string;
  jobsFound: number;
  hadError: boolean;
}

export interface ZeroResultStreakCheck {
  isHealthy: boolean;
  consecutiveZeroRuns: number;
  message: string;
}

// Accumulates results for the current process only. scripts/apply.ts calls
// reportSearchResult() once per search as the run progresses, then
// checkZeroResultStreak() once at the end (no args — reads the accumulated
// state). Passing an explicit array is also supported for unit testing.
const searchResultsThisRun: SearchResult[] = [];

export function reportSearchResult(searchName: string, jobsFound: number, hadError: boolean): void {
  searchResultsThisRun.push({ searchName, jobsFound, hadError });
}

export function loadZeroResultStreak(): ZeroResultStreak {
  if (!fs.existsSync(STREAK_PATH)) return { consecutiveZeroRuns: 0, lastRunTimestamp: '' };
  try {
    const parsed = JSON.parse(fs.readFileSync(STREAK_PATH, 'utf-8')) as Partial<ZeroResultStreak>;
    return {
      consecutiveZeroRuns: typeof parsed.consecutiveZeroRuns === 'number' ? parsed.consecutiveZeroRuns : 0,
      lastRunTimestamp: typeof parsed.lastRunTimestamp === 'string' ? parsed.lastRunTimestamp : '',
    };
  } catch {
    return { consecutiveZeroRuns: 0, lastRunTimestamp: '' };
  }
}

export function saveZeroResultStreak(streak: ZeroResultStreak): void {
  fs.mkdirSync(path.dirname(STREAK_PATH), { recursive: true });
  fs.writeFileSync(STREAK_PATH, JSON.stringify(streak, null, 2), 'utf-8');
}

// A run counts as "zero-result" only if every search that ran returned zero
// jobs AND none of them errored out (a nav timeout isn't evidence of a quiet
// job market — it's evidence something broke, and is already logged/handled
// elsewhere; conflating the two would mask real scraper breakage behind the
// 3-run grace period meant for legitimate quiet days).
export function checkZeroResultStreak(
  searchResults: SearchResult[] = searchResultsThisRun,
): ZeroResultStreakCheck {
  const totalJobs = searchResults.reduce((sum, r) => sum + r.jobsFound, 0);
  const anyError = searchResults.some((r) => r.hadError);
  const isZeroResultRun = searchResults.length > 0 && totalJobs === 0 && !anyError;

  const prevStreak = loadZeroResultStreak();
  const consecutiveZeroRuns = isZeroResultRun ? prevStreak.consecutiveZeroRuns + 1 : 0;
  saveZeroResultStreak({ consecutiveZeroRuns, lastRunTimestamp: new Date().toISOString() });

  if (consecutiveZeroRuns >= ZERO_STREAK_FAIL_THRESHOLD) {
    return {
      isHealthy: false,
      consecutiveZeroRuns,
      message:
        `${consecutiveZeroRuns} consecutive runs returned zero jobs across every search with no errors — ` +
        `likely a scraper/selector break, not a quiet day.`,
    };
  }
  if (isZeroResultRun) {
    return {
      isHealthy: true,
      consecutiveZeroRuns,
      message: `Zero jobs found this run (streak: ${consecutiveZeroRuns}/${ZERO_STREAK_FAIL_THRESHOLD}) — within normal variance.`,
    };
  }
  return { isHealthy: true, consecutiveZeroRuns: 0, message: 'Jobs found (or a search errored) this run — streak reset.' };
}

// ── OpenRouter circuit breaker (in-memory, per-run only) ──────────────────────

let consecutiveOpenRouterFailures = 0;

export function reportOpenRouterFailure(): void {
  consecutiveOpenRouterFailures++;
  if (consecutiveOpenRouterFailures === CIRCUIT_BREAKER_THRESHOLD) {
    logger.error('run-health: OpenRouter circuit breaker tripped — AI is sustained-down for this run', {
      consecutiveFailures: consecutiveOpenRouterFailures,
    });
  }
}

export function reportOpenRouterSuccess(): void {
  consecutiveOpenRouterFailures = 0;
}

export function isCircuitOpen(): boolean {
  return consecutiveOpenRouterFailures >= CIRCUIT_BREAKER_THRESHOLD;
}
