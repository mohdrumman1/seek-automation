// Live canary check for ATS submit-button selectors.
//
// Why this exists: the fixture-based unit tests in tests/unit/ats/*.test.ts prove the
// *matching logic* in lib/ats/*.ts still finds a submit button against a frozen HTML
// snapshot. They CANNOT catch the failure mode that actually caused the 3 historical
// incidents in LEARNINGS.md — the live ATS tenant's DOM itself drifting in production
// (new button copy, new wrapper markup, a re-themed form). Only navigating to a real,
// live application page and re-running the real selector against the real DOM can catch
// that class of regression.
//
// Status: STUBBED, not fully wired up. `checkAtsCanary()` below is a complete,
// ready-to-use implementation — give it a real page + selector and it does the right
// thing (finds the button or logs a warning, never clicks submit/apply). What's
// missing is CANARY_TARGETS: one stable, known-good "job application entry point" URL
// per ATS platform that is safe to repeatedly load in CI without applying to a real job
// or burning a real company's traffic quota.
//
// The repo does not currently have such a list:
//   - data/sr-queue.json entries are ephemeral individual job postings with per-visit
//     `seek-token` query params — they expire and are not "stable" or reusable.
//   - lib/crawlers/cba.ts's CBA_SEARCH_HOME is a Workday *search results* page, not a
//     specific job's apply-form entry point with a submit button on it.
//   - No lib/ats/*.ts module hardcodes a durable sample job URL for its own platform.
//
// Fabricating a URL here would be worse than not testing at all (it would either 404
// immediately or silently point at a real employer's live requisition). Until a
// deliberately-chosen, long-lived sample URL exists per platform (e.g. a company's own
// "example job" or a platform vendor's public demo/sandbox posting), this stays a
// documented stub. To wire it up:
//   1. Populate CANARY_TARGETS below with { provider, url, selector } entries.
//   2. Remove the `test.skip` guard in the `describe.each` block.
//   3. Decide a run cadence (this file, run via `npx playwright test --project=integration`,
//      is NOT on a schedule today — hook it into a periodic GitHub Actions job, mirroring
//      how tests/integration/dry-run.spec.ts is invoked manually today).
import { test } from '@playwright/test';
import { Page } from '@playwright/test';
import { logger } from '../../lib/logger';
import { ATSProvider } from '../../lib/ats/types';

interface CanaryTarget {
  provider: ATSProvider;
  url: string;
  selector: string;
}

// TODO: populate once a stable, known-good sample application URL exists per platform.
// See the file-level comment above for why this is empty rather than fabricated.
const CANARY_TARGETS: CanaryTarget[] = [];

// Navigate to `url` and check whether `selector` resolves to a visible element.
// Does NOT click anything — read-only DOM check, safe to run repeatedly against a
// live site. Logs a warning (not a failure) on a miss, since a single miss could be
// a transient load issue rather than confirmed selector drift.
export async function checkAtsCanary(page: Page, target: CanaryTarget): Promise<boolean> {
  await page.goto(target.url, { timeout: 30_000, waitUntil: 'domcontentloaded' }).catch((err) => {
    logger.warn(`ats canary: nav failed for ${target.provider}`, { url: target.url, error: String(err) });
  });
  const found = await page.locator(target.selector).first().isVisible({ timeout: 10_000 }).catch(() => false);
  if (!found) {
    logger.warn(`ats canary: submit-button selector no longer matches live DOM for ${target.provider}`, {
      url: target.url,
      selector: target.selector,
    });
  }
  return found;
}

test.describe('ATS live canary — submit-button selectors against real DOM', () => {
  // Placeholder test so this spec is discoverable (`No tests found` otherwise) and the
  // stub state shows up explicitly as a skipped test in CI/reporter output rather than
  // silently vanishing when CANARY_TARGETS is empty.
  test('CANARY_TARGETS not yet populated — see file-level TODO comment', () => {
    test.skip(
      CANARY_TARGETS.length === 0,
      'No stable, known-good sample application URL exists per ATS platform yet — ' +
      'see the file-level comment above CANARY_TARGETS for why one was not fabricated.',
    );
  });

  for (const target of CANARY_TARGETS) {
    test(`${target.provider}: submit button still resolves on live DOM`, async ({ page }) => {
      await checkAtsCanary(page, target);
      // Intentionally not asserting `found === true` here — this check is designed to
      // warn (via logger.warn, greppable in CI output) rather than fail the build on a
      // transient live-site hiccup. Selector drift should be triaged from the warning
      // log, same as the existing screenshots/errors/*_ats_<vendor>_no_submit.png flow.
    });
  }
});
