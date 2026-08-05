// Phase 2: CSV tracking for all application outcomes and run summaries.
import * as fs from 'fs';
import * as path from 'path';

export const DATA_DIR = path.resolve(__dirname, '../data');

export function deriveJobId(url: string): string {
  try {
    const seekMatch = url.match(/\/job\/(\d+)/);
    if (seekMatch) return `seek-${seekMatch[1]}`;
    const parsed = new URL(url);
    const slug = parsed.pathname.split('/').filter(Boolean).pop() || 'root';
    return `${parsed.hostname.replace(/\./g, '-')}-${slug}`.slice(0, 80);
  } catch {
    return url.slice(0, 80);
  }
}

export function escapeCsv(val: unknown): string {
  const raw = String(val ?? '');
  const s = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function appendRow(filePath: string, headers: string[], row: Record<string, unknown>): void {
  const line = headers.map((h) => escapeCsv(row[h])).join(',') + '\n';
  const exists = fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  if (!exists) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, headers.join(',') + '\n' + line, 'utf-8');
  } else {
    fs.appendFileSync(filePath, line, 'utf-8');
  }
}

export interface JobMeta {
  jobId: string;
  platform: string;
  title: string;
  company: string;
  location: string;
  salaryText: string;
  workType: string;
  runId: string;
  atsProvider?: string;
  externalUrl?: string;
  routeMode?: string;
}

const APP_HEADERS = [
  'job_id', 'platform', 'title', 'company', 'location', 'salary_text', 'work_type',
  'applied_at', 'resume_variant', 'run_id', 'ats_provider', 'external_url', 'route_mode',
];
const SKIP_HEADERS = [
  'job_id', 'platform', 'title', 'company', 'location', 'salary_text', 'work_type',
  'skipped_at', 'skip_reason', 'run_id', 'ats_provider', 'external_url', 'route_mode',
];
const FAIL_HEADERS = [
  'job_id', 'platform', 'title', 'company', 'location', 'salary_text', 'work_type',
  'failed_at', 'failure_reason', 'requires_manual_review', 'screenshot_path', 'run_id', 'ats_provider', 'external_url', 'route_mode',
];
const RUN_HEADERS = [
  'run_id', 'started_at', 'ended_at', 'duration_sec',
  'applied', 'skipped', 'failed', 'dry_run', 'status',
];

export function recordApplication(meta: JobMeta & { resumeVariant: string }, _dataDir = DATA_DIR): void {
  appendRow(path.join(_dataDir, 'applications.csv'), APP_HEADERS, {
    job_id: meta.jobId,
    platform: meta.platform,
    title: meta.title,
    company: meta.company,
    location: meta.location,
    salary_text: meta.salaryText,
    work_type: meta.workType,
    applied_at: new Date().toISOString(),
    resume_variant: meta.resumeVariant,
    run_id: meta.runId,
    ats_provider: meta.atsProvider ?? '',
    external_url: meta.externalUrl ?? '',
    route_mode: meta.routeMode ?? '',
  });
}

export function recordSkip(meta: JobMeta & { skipReason: string }, _dataDir = DATA_DIR): void {
  appendRow(path.join(_dataDir, 'skipped_jobs.csv'), SKIP_HEADERS, {
    job_id: meta.jobId,
    platform: meta.platform,
    title: meta.title,
    company: meta.company,
    location: meta.location,
    salary_text: meta.salaryText,
    work_type: meta.workType,
    skipped_at: new Date().toISOString(),
    skip_reason: meta.skipReason,
    run_id: meta.runId,
    ats_provider: meta.atsProvider ?? '',
    external_url: meta.externalUrl ?? '',
    route_mode: meta.routeMode ?? '',
  });
}

export function recordFailure(
  meta: JobMeta & {
    failureReason: string;
    requiresManualReview?: boolean;
    screenshotPath?: string;
  },
  _dataDir = DATA_DIR
): void {
  appendRow(path.join(_dataDir, 'failed_jobs.csv'), FAIL_HEADERS, {
    job_id: meta.jobId,
    platform: meta.platform,
    title: meta.title,
    company: meta.company,
    location: meta.location,
    salary_text: meta.salaryText,
    work_type: meta.workType,
    failed_at: new Date().toISOString(),
    failure_reason: meta.failureReason,
    requires_manual_review: meta.requiresManualReview ? 'true' : 'false',
    screenshot_path: meta.screenshotPath ?? '',
    run_id: meta.runId,
    ats_provider: meta.atsProvider ?? '',
    external_url: meta.externalUrl ?? '',
    route_mode: meta.routeMode ?? '',
  });
}

export function recordRun(data: {
  runId: string;
  startedAt: string;
  applied: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  status: 'success' | 'failed';
}, _dataDir = DATA_DIR): void {
  const startMs = new Date(data.startedAt).getTime();
  appendRow(path.join(_dataDir, 'runs.csv'), RUN_HEADERS, {
    run_id: data.runId,
    started_at: data.startedAt,
    ended_at: new Date().toISOString(),
    duration_sec: Math.round((Date.now() - startMs) / 1000),
    applied: data.applied,
    skipped: data.skipped,
    failed: data.failed,
    dry_run: data.dryRun ? 'true' : 'false',
    status: data.status,
  });
}
