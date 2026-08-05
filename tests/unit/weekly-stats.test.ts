import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const files = vi.hoisted(() => new Map<string, string>());

vi.mock('fs', () => ({
  existsSync: (file: string) => files.has(file),
  readFileSync: (file: string) => {
    const contents = files.get(file);
    if (contents === undefined) throw new Error(`missing file: ${file}`);
    return contents;
  },
  mkdirSync: vi.fn(),
  writeFileSync: (file: string, contents: string) => files.set(file, contents),
  unlinkSync: (file: string) => files.delete(file),
}));

const STATS_PATH = path.resolve(__dirname, '../../data/weekly-stats.json');

beforeEach(() => {
  files.clear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-06T12:00:00.000Z'));
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  files.clear();
});

describe('weekly stats', () => {
  it('starts empty when no state file exists', async () => {
    const { loadWeeklyStats, getWeeklyDigest } = await import('../../lib/weekly-stats');

    expect(loadWeeklyStats()).toEqual({ days: {} });
    expect(getWeeklyDigest()).toEqual({
      runs: 0,
      jobsFound: 0,
      applied: 0,
      skipped: 0,
      failed: 0,
      recentZeroResultStreak: 0,
      maxZeroResultStreak: 0,
    });
  });

  it('drops expired days and invalid counts', async () => {
    fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
    fs.writeFileSync(STATS_PATH, JSON.stringify({
      days: {
        '2026-07-30': { runs: 8, jobsFound: 80, applied: 8, skipped: 8, failed: 8 },
        '2026-08-01': {
          runs: 1,
          jobsFound: -1,
          applied: 1.5,
          skipped: '2',
          failed: 3,
          latestZeroResultStreak: -1,
          maxZeroResultStreak: 2,
          company: 'private',
        },
        invalid: { runs: 9 },
      },
    }), 'utf-8');

    const { loadWeeklyStats } = await import('../../lib/weekly-stats');

    expect(loadWeeklyStats()).toEqual({
      days: {
        '2026-08-01': {
          runs: 1,
          jobsFound: 0,
          applied: 0,
          skipped: 0,
          failed: 3,
          maxZeroResultStreak: 2,
        },
      },
    });
  });

  it('accumulates only numeric daily aggregates and streaks', async () => {
    const { recordWeeklyRun, loadWeeklyStats, getWeeklyDigest } = await import('../../lib/weekly-stats');

    recordWeeklyRun({ jobsFound: 4, applied: 1, skipped: 2, failed: 1, zeroResultStreak: 0 });
    recordWeeklyRun({ jobsFound: 3, applied: 2, skipped: 1, failed: 0, zeroResultStreak: 4 });

    expect(loadWeeklyStats()).toEqual({
      days: {
        '2026-08-06': {
          runs: 2,
          jobsFound: 7,
          applied: 3,
          skipped: 3,
          failed: 1,
          latestZeroResultStreak: 4,
          maxZeroResultStreak: 4,
        },
      },
    });
    expect(getWeeklyDigest()).toEqual({
      runs: 2,
      jobsFound: 7,
      applied: 3,
      skipped: 3,
      failed: 1,
      recentZeroResultStreak: 4,
      maxZeroResultStreak: 4,
    });
  });

  it('uses latest streak and largest streak across retained days', async () => {
    const { getWeeklyDigest } = await import('../../lib/weekly-stats');

    expect(getWeeklyDigest({
      days: {
        '2026-08-01': {
          runs: 1,
          jobsFound: 1,
          applied: 0,
          skipped: 1,
          failed: 0,
          latestZeroResultStreak: 5,
          maxZeroResultStreak: 5,
        },
        '2026-08-06': {
          runs: 2,
          jobsFound: 6,
          applied: 3,
          skipped: 2,
          failed: 1,
          latestZeroResultStreak: 1,
          maxZeroResultStreak: 3,
        },
      },
    })).toEqual({
      runs: 3,
      jobsFound: 7,
      applied: 3,
      skipped: 3,
      failed: 1,
      recentZeroResultStreak: 1,
      maxZeroResultStreak: 5,
    });
  });
});
