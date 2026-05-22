import { test, expect } from '@playwright/test';
import { spawnSync } from 'child_process';

test.describe('integration: dry-run apply', () => {
  test('apply --dry-run exits 0 and reports RESULT', () => {
    test.skip(
      !process.env.SEEK_SESSION_COOKIES,
      'SEEK_SESSION_COOKIES not set — skipping integration test',
    );
    test.skip(
      !process.env.OPENROUTER_API_KEY,
      'OPENROUTER_API_KEY not set — skipping integration test',
    );

    test.setTimeout(120_000);

    const jobUrl =
      process.env.INTEGRATION_JOB_URL ?? 'https://www.seek.com.au/job/81234567';

    const result = spawnSync(
      'npm',
      ['run', 'seek', '--', '--url', jobUrl, '--dry-run'],
      {
        encoding: 'utf-8',
        timeout: 115_000,
        cwd: process.cwd(),
      },
    );

    const output = (result.stdout ?? '') + (result.stderr ?? '');

    // Exit code must be 0 — any unhandled exception produces non-zero
    expect(result.status, `Process exited with non-zero code.\nOutput:\n${output}`).toBe(0);

    // Must report one of the two known result tokens
    const hasResult =
      output.includes('RESULT: APPLIED') || output.includes('RESULT: NOT APPLIED');
    expect(hasResult, `Expected RESULT: APPLIED or RESULT: NOT APPLIED in output.\nOutput:\n${output}`).toBe(true);

    // Stale cookies would surface as session_expired — flag it as a setup issue
    expect(
      output,
      'Output contains "session_expired" — SEEK_SESSION_COOKIES may be stale. Refresh the secret and re-run.',
    ).not.toContain('session_expired');
  });
});
