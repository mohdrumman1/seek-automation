import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// daily-cap.ts resolves its state file relative to __dirname at import time
// (same pattern as lib/run-health.ts's STREAK_PATH). Point at the real path
// and clean up before/after each test so this never collides with actual bot
// state on disk.
const CAP_PATH = path.resolve(__dirname, '../../data/daily-application-count.json');

function removeCapFile(): void {
  if (fs.existsSync(CAP_PATH)) fs.unlinkSync(CAP_PATH);
}

beforeEach(() => {
  removeCapFile();
  vi.resetModules();
});

afterEach(() => {
  removeCapFile();
});

describe('daily application cap', () => {
  it('starts at count 0 for today when no file exists', async () => {
    const { loadDailyCount } = await import('../../lib/daily-cap');
    const today = new Date().toISOString().slice(0, 10);
    const loaded = loadDailyCount();
    expect(loaded.count).toBe(0);
    expect(loaded.date).toBe(today);
  });

  it('is not reached below the cap', async () => {
    const { isDailyCapReached, incrementDailyCount } = await import('../../lib/daily-cap');
    for (let i = 0; i < 29; i++) incrementDailyCount();
    expect(isDailyCapReached()).toBe(false);
  });

  it('is reached once count hits 30', async () => {
    const { isDailyCapReached, incrementDailyCount, DAILY_APPLICATION_CAP } = await import('../../lib/daily-cap');
    expect(DAILY_APPLICATION_CAP).toBe(30);
    for (let i = 0; i < 30; i++) incrementDailyCount();
    expect(isDailyCapReached()).toBe(true);
  });

  it('persists the count to disk across module reloads', async () => {
    const mod1 = await import('../../lib/daily-cap');
    mod1.incrementDailyCount();
    mod1.incrementDailyCount();

    vi.resetModules();
    const mod2 = await import('../../lib/daily-cap');
    const loaded = mod2.loadDailyCount();
    expect(loaded.count).toBe(2);
  });

  it('resets the count when the stored date is not today (UTC rollover)', async () => {
    const { saveDailyCount, loadDailyCount } = await import('../../lib/daily-cap');
    saveDailyCount({ date: '2020-01-01', count: 25 });
    const loaded = loadDailyCount();
    expect(loaded.count).toBe(0);
    expect(loaded.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it('treats a corrupt cap file as zero count for today', async () => {
    fs.mkdirSync(path.dirname(CAP_PATH), { recursive: true });
    fs.writeFileSync(CAP_PATH, 'not json', 'utf-8');
    const { loadDailyCount } = await import('../../lib/daily-cap');
    const loaded = loadDailyCount();
    expect(loaded.count).toBe(0);
  });
});
