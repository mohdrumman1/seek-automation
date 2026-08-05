// Hard daily cap on total automated applications, across ALL runs combined
// (not per-run). Persisted to data/daily-application-count.json and restored
// across ephemeral GitHub Actions runners via actions/cache — the SAME
// pattern lib/run-health.ts uses for data/zero-result-streak.json (see the
// "Restore" cache steps in .github/workflows/seek-apply.yml).
//
// Deliberately has no imports from scripts/apply.ts — that script calls in
// to check/increment, not the other way around (same layering as run-health.ts).

import * as fs from 'fs';
import * as path from 'path';

const CAP_PATH = path.resolve(__dirname, '../data/daily-application-count.json');

// The real backstop against over-applying in a single day, regardless of how
// many scheduled runs fire or how large any single run's own cap is.
export const DAILY_APPLICATION_CAP = 30;

export interface DailyCount {
  date: string; // YYYY-MM-DD, UTC
  count: number;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function loadDailyCount(): DailyCount {
  const today = todayUtc();
  if (!fs.existsSync(CAP_PATH)) return { date: today, count: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(CAP_PATH, 'utf-8')) as Partial<DailyCount>;
    const date = typeof parsed.date === 'string' ? parsed.date : today;
    const count = typeof parsed.count === 'number' ? parsed.count : 0;
    // Roll over when the UTC date has changed since the last write.
    if (date !== today) return { date: today, count: 0 };
    return { date, count };
  } catch {
    return { date: today, count: 0 };
  }
}

export function saveDailyCount(data: DailyCount): void {
  fs.mkdirSync(path.dirname(CAP_PATH), { recursive: true });
  fs.writeFileSync(CAP_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export function isDailyCapReached(): boolean {
  return loadDailyCount().count >= DAILY_APPLICATION_CAP;
}

export function incrementDailyCount(): DailyCount {
  const current = loadDailyCount();
  const next: DailyCount = { date: current.date, count: current.count + 1 };
  saveDailyCount(next);
  return next;
}
