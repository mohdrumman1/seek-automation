import * as fs from 'fs';
import * as path from 'path';

const STATS_PATH = path.resolve(__dirname, '../data/weekly-stats.json');
const WINDOW_DAYS = 7;

export interface DailyStats {
  runs: number;
  jobsFound: number;
  applied: number;
  skipped: number;
  failed: number;
  latestZeroResultStreak?: number;
  maxZeroResultStreak?: number;
}

export interface WeeklyStats {
  days: Record<string, DailyStats>;
}

export interface WeeklyRunStats {
  jobsFound: number;
  applied: number;
  skipped: number;
  failed: number;
  zeroResultStreak?: number;
}

export interface WeeklyDigest {
  runs: number;
  jobsFound: number;
  applied: number;
  skipped: number;
  failed: number;
  recentZeroResultStreak: number;
  maxZeroResultStreak: number;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function readDay(value: unknown): DailyStats {
  const day = value !== null && typeof value === 'object' ? value as Partial<DailyStats> : {};
  return {
    runs: isCount(day.runs) ? day.runs : 0,
    jobsFound: isCount(day.jobsFound) ? day.jobsFound : 0,
    applied: isCount(day.applied) ? day.applied : 0,
    skipped: isCount(day.skipped) ? day.skipped : 0,
    failed: isCount(day.failed) ? day.failed : 0,
    ...(isCount(day.latestZeroResultStreak) ? { latestZeroResultStreak: day.latestZeroResultStreak } : {}),
    ...(isCount(day.maxZeroResultStreak) ? { maxZeroResultStreak: day.maxZeroResultStreak } : {}),
  };
}

function cutoffUtc(days = WINDOW_DAYS): string {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  return cutoff.toISOString().slice(0, 10);
}

export function loadWeeklyStats(): WeeklyStats {
  if (!fs.existsSync(STATS_PATH)) return { days: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8')) as { days?: Record<string, unknown> };
    const cutoff = cutoffUtc();
    const days = Object.fromEntries(
      Object.entries(parsed.days ?? {})
        .filter(([date]) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= cutoff)
        .map(([date, value]) => [date, readDay(value)]),
    );
    return { days };
  } catch {
    return { days: {} };
  }
}

export function saveWeeklyStats(stats: WeeklyStats): void {
  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), 'utf-8');
}

export function recordWeeklyRun(run: WeeklyRunStats): void {
  const stats = loadWeeklyStats();
  const date = todayUtc();
  const day = stats.days[date] ?? readDay({});
  day.runs++;
  day.jobsFound += run.jobsFound;
  day.applied += run.applied;
  day.skipped += run.skipped;
  day.failed += run.failed;
  if (isCount(run.zeroResultStreak)) {
    day.latestZeroResultStreak = run.zeroResultStreak;
    day.maxZeroResultStreak = Math.max(day.maxZeroResultStreak ?? 0, run.zeroResultStreak);
  }
  stats.days[date] = day;
  saveWeeklyStats(stats);
}

export function getWeeklyDigest(stats = loadWeeklyStats()): WeeklyDigest {
  const days = Object.entries(stats.days).sort(([left], [right]) => left.localeCompare(right));
  const digest: WeeklyDigest = {
    runs: 0,
    jobsFound: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    recentZeroResultStreak: 0,
    maxZeroResultStreak: 0,
  };
  for (const [, day] of days) {
    digest.runs += day.runs;
    digest.jobsFound += day.jobsFound;
    digest.applied += day.applied;
    digest.skipped += day.skipped;
    digest.failed += day.failed;
    digest.maxZeroResultStreak = Math.max(digest.maxZeroResultStreak, day.maxZeroResultStreak ?? 0);
    if (day.latestZeroResultStreak !== undefined) digest.recentZeroResultStreak = day.latestZeroResultStreak;
  }
  return digest;
}
