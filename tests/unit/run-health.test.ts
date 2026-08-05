import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// run-health.ts resolves its state file relative to __dirname at import time
// (same pattern as lib/apply-utils.ts's APPLIED_LOG). Point at the real path
// and clean up before/after each test so this never collides with actual bot
// state on disk.
const STREAK_PATH = path.resolve(__dirname, '../../data/zero-result-streak.json');

function removeStreakFile(): void {
  if (fs.existsSync(STREAK_PATH)) fs.unlinkSync(STREAK_PATH);
}

beforeEach(() => {
  removeStreakFile();
  vi.resetModules();
});

afterEach(() => {
  removeStreakFile();
});

describe('checkZeroResultStreak', () => {
  it('stays healthy on a single zero-result run (streak 1/3)', async () => {
    const { checkZeroResultStreak } = await import('../../lib/run-health');
    const result = checkZeroResultStreak([
      { searchName: 'a', jobsFound: 0, hadError: false },
      { searchName: 'b', jobsFound: 0, hadError: false },
    ]);
    expect(result.isHealthy).toBe(true);
    expect(result.consecutiveZeroRuns).toBe(1);
  });

  it('escalates to unhealthy only after 3 consecutive zero-result runs', async () => {
    const { checkZeroResultStreak } = await import('../../lib/run-health');
    const zeroResults = [{ searchName: 'a', jobsFound: 0, hadError: false }];

    const r1 = checkZeroResultStreak(zeroResults);
    expect(r1.isHealthy).toBe(true);
    expect(r1.consecutiveZeroRuns).toBe(1);

    const r2 = checkZeroResultStreak(zeroResults);
    expect(r2.isHealthy).toBe(true);
    expect(r2.consecutiveZeroRuns).toBe(2);

    const r3 = checkZeroResultStreak(zeroResults);
    expect(r3.isHealthy).toBe(false);
    expect(r3.consecutiveZeroRuns).toBe(3);
  });

  it('resets the streak once a run finds jobs', async () => {
    const { checkZeroResultStreak } = await import('../../lib/run-health');
    const zero = [{ searchName: 'a', jobsFound: 0, hadError: false }];
    const found = [{ searchName: 'a', jobsFound: 5, hadError: false }];

    checkZeroResultStreak(zero);
    checkZeroResultStreak(zero);
    const recovered = checkZeroResultStreak(found);
    expect(recovered.isHealthy).toBe(true);
    expect(recovered.consecutiveZeroRuns).toBe(0);

    const afterRecovery = checkZeroResultStreak(zero);
    expect(afterRecovery.consecutiveZeroRuns).toBe(1);
  });

  it('does not count a run as zero-result if any search errored', async () => {
    const { checkZeroResultStreak } = await import('../../lib/run-health');
    const result = checkZeroResultStreak([
      { searchName: 'a', jobsFound: 0, hadError: true },
      { searchName: 'b', jobsFound: 0, hadError: false },
    ]);
    expect(result.isHealthy).toBe(true);
    expect(result.consecutiveZeroRuns).toBe(0);
  });

  it('persists the streak to disk across module reloads', async () => {
    const mod1 = await import('../../lib/run-health');
    mod1.checkZeroResultStreak([{ searchName: 'a', jobsFound: 0, hadError: false }]);

    vi.resetModules();
    const mod2 = await import('../../lib/run-health');
    const loaded = mod2.loadZeroResultStreak();
    expect(loaded.consecutiveZeroRuns).toBe(1);
  });
});

describe('reportSearchResult + checkZeroResultStreak (no-arg accumulation)', () => {
  it('accumulates reported results for the current run when called with no args', async () => {
    const { reportSearchResult, checkZeroResultStreak } = await import('../../lib/run-health');
    reportSearchResult('search-a', 0, false);
    reportSearchResult('search-b', 0, false);
    const result = checkZeroResultStreak();
    expect(result.isHealthy).toBe(true);
    expect(result.consecutiveZeroRuns).toBe(1);
  });
});

describe('OpenRouter circuit breaker', () => {
  it('is closed before any failures are reported', async () => {
    const { isCircuitOpen } = await import('../../lib/run-health');
    expect(isCircuitOpen()).toBe(false);
  });

  it('opens after 5 consecutive failures', async () => {
    const { reportOpenRouterFailure, isCircuitOpen } = await import('../../lib/run-health');
    for (let i = 0; i < 4; i++) reportOpenRouterFailure();
    expect(isCircuitOpen()).toBe(false);
    reportOpenRouterFailure();
    expect(isCircuitOpen()).toBe(true);
  });

  it('a success resets the failure count, closing the breaker', async () => {
    const { reportOpenRouterFailure, reportOpenRouterSuccess, isCircuitOpen } = await import('../../lib/run-health');
    for (let i = 0; i < 5; i++) reportOpenRouterFailure();
    expect(isCircuitOpen()).toBe(true);
    reportOpenRouterSuccess();
    expect(isCircuitOpen()).toBe(false);
  });
});
