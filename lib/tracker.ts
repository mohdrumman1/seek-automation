// Phase 2: CSV tracking for all application outcomes and run summaries.
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.resolve(__dirname, '../data');

function escapeCsv(val: unknown): string {
  const s = String(val ?? '');
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
}

const APP_HEADERS = [
  'job_id', 'platform', 'title', 'company', 'location', 'salary_text', 'work_type',
  'applied_at', 'resume_variant', 'run_id',
];
const SKIP_HEADERS = [
  'job_id', 'platform', 'title', 'company', 'location', 'salary_text', 'work_type',
  'skipped_at', 'skip_reason', 'run_id',
];
const FAIL_HEADERS = [
  'job_id', 'platform', 'title', 'company', 'location', 'salary_text', 'work_type',
  'failed_at', 'failure_reason', 'requires_manual_review', 'screenshot_path', 'run_id',
];
const RUN_HEADERS = [
  'run_id', 'started_at', 'ended_at', 'duration_sec',
  'applied', 'skipped', 'failed', 'dry_run', 'status',
];

export function recordApplication(meta: JobMeta & { resumeVariant: string }): void {
  appendRow(path.join(DATA_DIR, 'applications.csv'), APP_HEADERS, {
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
  });
}

export function recordSkip(meta: JobMeta & { skipReason: string }): void {
  appendRow(path.join(DATA_DIR, 'skipped_jobs.csv'), SKIP_HEADERS, {
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
  });
}

export function recordFailure(
  meta: JobMeta & {
    failureReason: string;
    requiresManualReview?: boolean;
    screenshotPath?: string;
  }
): void {
  appendRow(path.join(DATA_DIR, 'failed_jobs.csv'), FAIL_HEADERS, {
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
}): void {
  const startMs = new Date(data.startedAt).getTime();
  appendRow(path.join(DATA_DIR, 'runs.csv'), RUN_HEADERS, {
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
