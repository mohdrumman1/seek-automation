import { Page } from '@playwright/test';
import { JobDetails, ApplyConfig } from '../platforms/types';
import { ATSResult } from './types';
import {
  ATS_CONTACT, acceptCookies, fillTextByHints, fillCoverLetter,
  uploadResumeFile, getBaseResumePath, hasSensitiveRequiredField,
  answerGenericQuestions, isSuccessPage,
} from './common';
import { captureAndAnalyze } from '../error-analyzer';
import { logger } from '../logger';

// Exported for unit-test regression coverage (tests/unit/ats/jobadder.test.ts).
export const JOBADDER_SUBMIT_SELECTOR =
  'button:has-text("Submit application"), button:has-text("Submit Application"), ' +
  'button:has-text("Submit"), button:has-text("Send application"), ' +
  'button:has-text("Apply now"), button:has-text("Apply Now"), button:has-text("Apply"), ' +
  // `input[value*="Submit" i]` intentionally omitted — it can match hidden/text
  // inputs whose value happens to contain "Submit" (e.g. type="button"). The
  // `input[type="submit"]` above already covers the real submit-input case.
  'button[type="submit"], input[type="submit"], ' +
  '[data-test-id*="submit" i], [data-testid*="submit" i], [data-cy*="submit" i], ' +
  '.js-submit-application, [role="button"]:has-text("Submit")';

export async function applyJobAdder(
  page: Page,
  details: JobDetails,
  config: ApplyConfig,
  resumePath: string | null,
  coverLetter: string,
): Promise<ATSResult> {
  const ctx = { job_title: details.title, company: details.company };

  // JobAdder usually loads the form directly; no cookie banner either.
  await acceptCookies(page);

  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

  // Dismiss "Want to apply later?" / save-for-later popups that block the form.
  const popupClose = page.locator(
    '[aria-label="Close"], button:has-text("No thanks"), button:has-text("No, continue"), ' +
    'button:has-text("Dismiss"), button:has-text("Continue applying"), [data-dismiss="modal"], ' +
    '.modal-header button.close'
  ).first();
  if (await popupClose.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await popupClose.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  const sensitive = await hasSensitiveRequiredField(page);
  if (sensitive) {
    return { status: 'needs_manual_review', reason: `sensitive_field:${sensitive.slice(0, 60)}` };
  }

  const resolvedResume = resumePath ?? getBaseResumePath(config.resumeVariant);
  if (resolvedResume) await uploadResumeFile(page, resolvedResume);

  // JobAdder exposes name attributes — use those first, then label hints.
  await fillByNameAttr(page, 'firstName', ATS_CONTACT.firstName);
  await fillByNameAttr(page, 'lastName',  ATS_CONTACT.lastName);
  await fillByNameAttr(page, 'email',     ATS_CONTACT.email);
  await fillByNameAttr(page, 'phone',     ATS_CONTACT.phone);

  // Fallback label hints.
  await fillTextByHints(page, [/first.?name/i, /given name/i],                       ATS_CONTACT.firstName);
  await fillTextByHints(page, [/last.?name/i, /surname/i, /family name/i],            ATS_CONTACT.lastName);
  await fillTextByHints(page, [/^name$/i, /full.?name/i, /your name/i],               ATS_CONTACT.fullName);
  await fillTextByHints(page, [/e-?mail/i],                                            ATS_CONTACT.email);
  await fillTextByHints(page, [/phone/i, /mobile/i, /telephone/i],                    ATS_CONTACT.phone);
  await fillTextByHints(page, [/city/i, /suburb/i],                                   ATS_CONTACT.city);
  await fillTextByHints(page, [/linkedin/i],                                           ATS_CONTACT.linkedin);

  await fillCoverLetter(page, coverLetter);
  await answerGenericQuestions(page, config.kb);

  // CAPTCHA guard: if a CAPTCHA widget is visible, flag for manual review.
  const hasCaptcha = await page.locator(
    'iframe[src*="recaptcha"], iframe[src*="turnstile"], iframe[src*="hcaptcha"]'
  ).first().isVisible({ timeout: 2_000 }).catch(() => false);
  if (hasCaptcha) {
    logger.warn('ats: jobadder — CAPTCHA detected', ctx);
    return { status: 'needs_manual_review', reason: 'ats_captcha' };
  }

  // Submit. Broadened selector list — JobAdder tenants vary in button copy/attrs.
  const submitBtn = page.locator(JOBADDER_SUBMIT_SELECTOR).first();
  if (!(await submitBtn.isVisible({ timeout: 4_000 }).catch(() => false))) {
    await captureAndAnalyze(page, 'ats_jobadder_no_submit', ctx);
    return { status: 'failed', reason: 'ats_jobadder_no_submit' };
  }
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  if (!(await config.beforeSubmit?.() ?? true)) {
    return { status: 'skipped', reason: 'daily_cap_reached' };
  }
  await submitBtn.click().catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2_000);

  // Check for CAPTCHA after submit (sometimes only shown then).
  const hasCaptchaAfter = await page.locator(
    'iframe[src*="recaptcha"], iframe[src*="turnstile"], iframe[src*="hcaptcha"]'
  ).first().isVisible({ timeout: 2_000 }).catch(() => false);
  if (hasCaptchaAfter) {
    return { status: 'needs_manual_review', reason: 'ats_captcha' };
  }

  if (await isSuccessPage(page, [/thank.?you.{0,30}application/i, /application has been/i])) {
    logger.info('ats: jobadder — applied', ctx);
    return { status: 'applied' };
  }

  await captureAndAnalyze(page, 'ats_jobadder_no_submit', ctx);
  return { status: 'failed', reason: 'ats_jobadder_submit_failed' };
}

async function fillByNameAttr(page: Page, name: string, value: string): Promise<void> {
  const el = page.locator(`input[name="${name}"]`).first();
  if (await el.count() > 0 && !(await el.inputValue().catch(() => ''))) {
    await el.fill(value).catch(() => {});
  }
}
