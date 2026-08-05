// Small structured summary of a single bot run, written to tmp/run-summary.json
// so a GitHub Actions workflow step can read it (via jq) and format a Job
// Summary + optional webhook alert, without re-deriving numbers that
// scripts/apply.ts / scripts/company-apply.ts already have in memory.
//
// tmp/ is already gitignored scratch space uploaded as a short-lived CI
// artifact (see tmp/bot.log, tmp/analyze.log) — this file follows the same
// pattern and is never committed.

import * as fs from 'fs';
import * as path from 'path';

export type RunStatus = 'OK' | 'WARN' | 'FAIL';

export interface RunSummary {
  status: RunStatus;
  jobsFound: number;
  applied: number;
  skipped: number;
  failed: number;
  consecutiveZeroRuns: number;
  message: string;
}

const SUMMARY_PATH = path.resolve(__dirname, '../tmp/run-summary.json');

// WARN at 1-2 consecutive zero-result runs, FAIL at 3+ — mirrors
// lib/run-health.ts's ZERO_STREAK_FAIL_THRESHOLD (deliberately not imported;
// run-health.ts is out of scope to modify, so the threshold is duplicated as
// a literal here rather than adding a new exported constant to that file).
// Any other run failure (session expired, crash, resume_no_valid_option,
// etc — reflected by runFailed) is also a FAIL regardless of the streak.
export function computeRunStatus(runFailed: boolean, consecutiveZeroRuns: number): RunStatus {
  if (runFailed || consecutiveZeroRuns >= 3) return 'FAIL';
  if (consecutiveZeroRuns >= 1) return 'WARN';
  return 'OK';
}

export function writeRunSummary(summary: RunSummary, outPath = SUMMARY_PATH): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf-8');
}
