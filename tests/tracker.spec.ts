import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordApplication, recordSkip, recordFailure, recordRun } from '../lib/tracker';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-test-'));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function readCsv(dir: string, filename: string): string[][] {
  const content = fs.readFileSync(path.join(dir, filename), 'utf-8');
  return content
    .trim()
    .split('\n')
    .map((line) => line.split(','));
}

const baseMeta = {
  jobId: '12345',
  platform: 'seek',
  title: 'Senior Project Manager',
  company: 'Acme Corp',
  location: 'Sydney NSW',
  salaryText: '$120,000 - $140,000',
  workType: 'Full time',
  runId: '2026-01-01T00:00:00.000Z',
};

test.describe('tracker — recordApplication', () => {
  test('creates applications.csv with header on first write', () => {
    const dir = makeTmpDir();
    try {
      recordApplication({ ...baseMeta, resumeVariant: 'pm' }, dir);
      expect(fs.existsSync(path.join(dir, 'applications.csv'))).toBe(true);
      const rows = readCsv(dir, 'applications.csv');
      expect(rows[0]).toContain('job_id');
      expect(rows[0]).toContain('title');
      expect(rows[0]).toContain('resume_variant');
      expect(rows[0]).toContain('run_id');
    } finally {
      cleanupDir(dir);
    }
  });

  test('writes correct values in data row', () => {
    const dir = makeTmpDir();
    try {
      recordApplication({ ...baseMeta, resumeVariant: 'se' }, dir);
      const content = fs.readFileSync(path.join(dir, 'applications.csv'), 'utf-8');
      expect(content).toContain('12345');
      expect(content).toContain('seek');
      expect(content).toContain('se');
      expect(content).toContain('2026-01-01T00:00:00.000Z');
    } finally {
      cleanupDir(dir);
    }
  });

  test('appends second row without duplicating header', () => {
    const dir = makeTmpDir();
    try {
      recordApplication({ ...baseMeta, resumeVariant: 'pm' }, dir);
      recordApplication({ ...baseMeta, jobId: '99999', resumeVariant: 'se' }, dir);
      const rows = readCsv(dir, 'applications.csv');
      // header + 2 data rows
      expect(rows.length).toBe(3);
      const headerCount = rows.filter((r) => r[0] === 'job_id').length;
      expect(headerCount).toBe(1);
    } finally {
      cleanupDir(dir);
    }
  });

  test('CSV-escapes values with commas', () => {
    const dir = makeTmpDir();
    try {
      recordApplication({ ...baseMeta, salaryText: '$120,000 - $140,000', resumeVariant: 'pm' }, dir);
      const content = fs.readFileSync(path.join(dir, 'applications.csv'), 'utf-8');
      // salary value with comma must be quoted
      expect(content).toContain('"$120,000 - $140,000"');
    } finally {
      cleanupDir(dir);
    }
  });
});

test.describe('tracker — recordSkip', () => {
  test('creates skipped_jobs.csv with correct headers', () => {
    const dir = makeTmpDir();
    try {
      recordSkip({ ...baseMeta, skipReason: 'external_apply' }, dir);
      const rows = readCsv(dir, 'skipped_jobs.csv');
      expect(rows[0]).toContain('skip_reason');
      expect(rows[0]).toContain('skipped_at');
    } finally {
      cleanupDir(dir);
    }
  });

  test('records skip reason in data row', () => {
    const dir = makeTmpDir();
    try {
      recordSkip({ ...baseMeta, skipReason: 'security_clearance_required' }, dir);
      const content = fs.readFileSync(path.join(dir, 'skipped_jobs.csv'), 'utf-8');
      expect(content).toContain('security_clearance_required');
    } finally {
      cleanupDir(dir);
    }
  });
});

test.describe('tracker — recordFailure', () => {
  test('creates failed_jobs.csv with correct headers', () => {
    const dir = makeTmpDir();
    try {
      recordFailure({ ...baseMeta, failureReason: 'page_limit_exceeded' }, dir);
      const rows = readCsv(dir, 'failed_jobs.csv');
      expect(rows[0]).toContain('failure_reason');
      expect(rows[0]).toContain('requires_manual_review');
      expect(rows[0]).toContain('screenshot_path');
    } finally {
      cleanupDir(dir);
    }
  });

  test('records requiresManualReview as true/false string', () => {
    const dir = makeTmpDir();
    try {
      recordFailure({ ...baseMeta, failureReason: 'validation_still_blocked', requiresManualReview: true }, dir);
      const content = fs.readFileSync(path.join(dir, 'failed_jobs.csv'), 'utf-8');
      expect(content).toContain('true');
    } finally {
      cleanupDir(dir);
    }
  });

  test('defaults requiresManualReview to false', () => {
    const dir = makeTmpDir();
    try {
      recordFailure({ ...baseMeta, failureReason: 'continue_button_not_found' }, dir);
      const content = fs.readFileSync(path.join(dir, 'failed_jobs.csv'), 'utf-8');
      expect(content).toContain('false');
    } finally {
      cleanupDir(dir);
    }
  });
});

test.describe('tracker — recordRun', () => {
  test('creates runs.csv with correct headers', () => {
    const dir = makeTmpDir();
    try {
      recordRun({
        runId: '2026-01-01T00:00:00.000Z',
        startedAt: '2026-01-01T00:00:00.000Z',
        applied: 5,
        skipped: 10,
        failed: 2,
        dryRun: false,
        status: 'success',
      }, dir);
      const rows = readCsv(dir, 'runs.csv');
      expect(rows[0]).toContain('run_id');
      expect(rows[0]).toContain('applied');
      expect(rows[0]).toContain('skipped');
      expect(rows[0]).toContain('failed');
      expect(rows[0]).toContain('status');
    } finally {
      cleanupDir(dir);
    }
  });

  test('records correct counts and status', () => {
    const dir = makeTmpDir();
    try {
      recordRun({
        runId: '2026-01-01T00:00:00.000Z',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        applied: 7,
        skipped: 3,
        failed: 1,
        dryRun: false,
        status: 'success',
      }, dir);
      const content = fs.readFileSync(path.join(dir, 'runs.csv'), 'utf-8');
      expect(content).toContain('success');
      // duration_sec should be ~60
      const lines = content.trim().split('\n');
      const headers = lines[0].split(',');
      const data = lines[1].split(',');
      const durIdx = headers.indexOf('duration_sec');
      const dur = Number(data[durIdx]);
      expect(dur).toBeGreaterThan(55);
      expect(dur).toBeLessThan(75);
    } finally {
      cleanupDir(dir);
    }
  });

  test('records dry_run flag', () => {
    const dir = makeTmpDir();
    try {
      recordRun({
        runId: '2026-01-01T00:00:00.000Z',
        startedAt: new Date().toISOString(),
        applied: 0,
        skipped: 0,
        failed: 0,
        dryRun: true,
        status: 'success',
      }, dir);
      const content = fs.readFileSync(path.join(dir, 'runs.csv'), 'utf-8');
      expect(content).toContain('true');
    } finally {
      cleanupDir(dir);
    }
  });
});

test.describe('tracker — CSV escaping edge cases', () => {
  test('escapes double quotes in values', () => {
    const dir = makeTmpDir();
    try {
      recordSkip({ ...baseMeta, title: 'Manager "Special"', skipReason: 'external_apply' }, dir);
      const content = fs.readFileSync(path.join(dir, 'skipped_jobs.csv'), 'utf-8');
      expect(content).toContain('"Manager ""Special"""');
    } finally {
      cleanupDir(dir);
    }
  });

  test('escapes newlines in values', () => {
    const dir = makeTmpDir();
    try {
      recordSkip({ ...baseMeta, title: 'Manager\nNewline', skipReason: 'external_apply' }, dir);
      const content = fs.readFileSync(path.join(dir, 'skipped_jobs.csv'), 'utf-8');
      expect(content).toContain('"Manager\nNewline"');
    } finally {
      cleanupDir(dir);
    }
  });

  test('does not quote plain values', () => {
    const dir = makeTmpDir();
    try {
      recordSkip({ ...baseMeta, title: 'ProjectManager', skipReason: 'external_apply' }, dir);
      const content = fs.readFileSync(path.join(dir, 'skipped_jobs.csv'), 'utf-8');
      expect(content).toContain('ProjectManager');
      // plain value should not be wrapped in quotes
      expect(content).not.toContain('"ProjectManager"');
    } finally {
      cleanupDir(dir);
    }
  });
});
