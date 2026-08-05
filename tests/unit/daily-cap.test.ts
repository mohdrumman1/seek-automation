import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let CAP_PATH = '';

function removeCapFile(): void {
  if (fs.existsSync(CAP_PATH)) fs.unlinkSync(CAP_PATH);
}

beforeEach(() => {
  CAP_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seek-daily-cap-')), 'daily-application-count.json');
  process.env.DAILY_CAP_PATH = CAP_PATH;
  vi.resetModules();
});

afterEach(() => {
  removeCapFile();
  fs.rmdirSync(path.dirname(CAP_PATH));
  delete process.env.DAILY_CAP_PATH;
  vi.resetModules();
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

  it.each([-5, 1.5, NaN, Infinity, -Infinity])('treats invalid stored count %p as zero', async (badCount) => {
    fs.mkdirSync(path.dirname(CAP_PATH), { recursive: true });
    fs.writeFileSync(CAP_PATH, JSON.stringify({ date: new Date().toISOString().slice(0, 10), count: badCount }), 'utf-8');
    const { loadDailyCount } = await import('../../lib/daily-cap');
    expect(loadDailyCount().count).toBe(0);
  });

  describe('reserveDailyApplication', () => {
    it('reserves successfully from 0 up through the cap', async () => {
      const { reserveDailyApplication, loadDailyCount, DAILY_APPLICATION_CAP } = await import('../../lib/daily-cap');
      for (let i = 0; i < DAILY_APPLICATION_CAP; i++) {
        expect(reserveDailyApplication()).toBe(true);
      }
      expect(loadDailyCount().count).toBe(DAILY_APPLICATION_CAP);
    });

    it('denies the reservation once the cap is reached, without over-counting', async () => {
      const { reserveDailyApplication, loadDailyCount, DAILY_APPLICATION_CAP } = await import('../../lib/daily-cap');
      for (let i = 0; i < DAILY_APPLICATION_CAP; i++) reserveDailyApplication();
      expect(reserveDailyApplication()).toBe(false);
      expect(loadDailyCount().count).toBe(DAILY_APPLICATION_CAP);
    });
  });
});
