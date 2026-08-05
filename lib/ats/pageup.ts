import { Page } from '@playwright/test';
import { JobDetails, ApplyConfig } from '../platforms/types';
import { ATSResult } from './types';
import {
  ATS_CONTACT, acceptCookies, fillTextByHints, fillCoverLetter,
  uploadResumeFile, getBaseResumePath, hasSensitiveRequiredField,
  answerGenericQuestions, isSuccessPage, clickNext,
} from './common';
import { captureAndAnalyze } from '../error-analyzer';
import { logger } from '../logger';

export async function applyPageUp(
  page: Page,
  details: JobDetails,
  config: ApplyConfig,
  resumePath: string | null,
  coverLetter: string,
): Promise<ATSResult> {
  const ctx = { job_title: details.title, company: details.company };

  await acceptCookies(page);

  const url = page.url();
  const isApplrIo = url.includes('applr.io');

  // SEEK OAuth authorization wall (au.seek.com/awsk/authorize) — `applr.io` and
  // some PageUp partner tenants route the user through SEEK OAuth to grant the
  // employer access to their SEEK profile before the actual form loads. If we
  // don't click "Allow access" here the URL never advances and every subsequent
  // wizard iteration bails as ats_pageup_no_submit. Confirmed root cause of the
  // Peoplebank / applr.io failure cluster in run 29535279622 (2026-07-16).
  await handleSeekOAuthAuthorize(page, ctx);

  // Click the Apply/Begin button. Broadened to cover PageUp gateway landing
  // pages (pageuppeople.com/apply/<tenant>/gateway/Default.aspx) that use
  // "Start application" / "Apply now" / "Apply for this job" wording.
  const applyBtn = page.locator(
    'button:has-text("Apply"), button:has-text("Begin application"), ' +
    'button:has-text("Start application"), button:has-text("Apply now"), ' +
    'button:has-text("Apply for this job"), ' +
    'a:has-text("Apply"), a:has-text("Begin"), a:has-text("Start application"), ' +
    'a:has-text("Apply now"), a:has-text("Apply for this job"), ' +
    'input[type="submit"][value*="Apply" i], input[type="button"][value*="Apply" i]'
  ).first();
  if (await applyBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await applyBtn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
    // The Apply click can itself redirect to the SEEK OAuth authorize wall.
    await handleSeekOAuthAuthorize(page, ctx);
  }

  // Account-creation wall check (classic PageUp).
  if (!isApplrIo) {
    const wallSel = 'a:has-text("Create account"), button:has-text("Register"), h1:has-text("Create an account")';
    if (await page.locator(wallSel).first().isVisible({ timeout: 3_000 }).catch(() => false)) {
      const guestBtn = page.locator(
        'a:has-text("Apply without an account"), button:has-text("Continue as guest"), ' +
        'a:has-text("Guest")'
      ).first();
      if (!(await guestBtn.isVisible({ timeout: 2_000 }).catch(() => false))) {
        return { status: 'skipped', reason: 'ats_requires_account' };
      }
      await guestBtn.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }
  }

  const resolvedResume = resumePath ?? getBaseResumePath(config.resumeVariant);
  let uploadedResume = false;
  let lastUrl = '';

  // Multi-step loop (PageUp classic can have 3–5 pages).
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.waitForTimeout(1_500);
    const currentUrl = page.url();

    // hCaptcha / error challenge page. Bail immediately — CAPTCHAs are unsolvable
    // and looping burns 8×1.5s + submit-timeout budget per job. Two fingerprints:
    // (1) the iframe (title-based match added — the previous `src*="hcaptcha"` /
    //     `.h-captcha` / `#hcaptcha` set missed PageUp's rendering, which is why
    //     run 29535279622 logged the "Uh oh" page as ats_pageup_no_submit rather
    //     than ats_pageup_captcha);
    // (2) the distinctive "Uh oh... It looks like something has gone wrong" text
    //     PageUp shows above the widget — reliable even when the iframe hasn't
    //     mounted yet on our first read.
    const hasHCaptcha = await page.locator(
      'iframe[src*="hcaptcha"], iframe[title*="hCaptcha" i], iframe[title*="captcha" i], ' +
      '.h-captcha, #hcaptcha, [data-hcaptcha-widget-id], [data-sitekey]'
    ).first().isVisible({ timeout: 500 }).catch(() => false);
    const hasErrorBanner = await page.locator('text=/uh\\s*oh.{0,60}gone wrong/i').first()
      .isVisible({ timeout: 200 }).catch(() => false);
    if (hasHCaptcha || hasErrorBanner) {
      logger.info('ats: pageup — hCaptcha/error page detected, skipping', ctx);
      return { status: 'failed', reason: 'ats_pageup_captcha' };
    }

    if (await isSuccessPage(page, [/application.{0,20}received/i, /applicationsubmitted/i])) {
      logger.info('ats: pageup — applied', ctx);
      return { status: 'applied' };
    }

    if (currentUrl === lastUrl && attempt > 0) {
      await captureAndAnalyze(page, 'ats_pageup_no_submit', ctx);
      return { status: 'failed', reason: 'ats_pageup_no_progress' };
    }
    lastUrl = currentUrl;

    const sensitive = await hasSensitiveRequiredField(page);
    if (sensitive) {
      return { status: 'needs_manual_review', reason: `sensitive_field:${sensitive.slice(0, 60)}` };
    }

    if (resolvedResume && !uploadedResume) {
      uploadedResume = await uploadResumeFile(page, resolvedResume);
    }

    // Fill contact fields.
    await fillTextByHints(page, [/first.?name/i, /given name/i],                       ATS_CONTACT.firstName);
    await fillTextByHints(page, [/last.?name/i, /surname/i, /family name/i],            ATS_CONTACT.lastName);
    await fillTextByHints(page, [/^name$/i, /full.?name/i, /your name/i],               ATS_CONTACT.fullName);
    await fillTextByHints(page, [/e-?mail/i],                                            ATS_CONTACT.email);
    await fillTextByHints(page, [/phone/i, /mobile/i, /contact number/i, /telephone/i], ATS_CONTACT.phone);
    await fillTextByHints(page, [/city/i, /suburb/i, /town/i],                          ATS_CONTACT.city);
    await fillTextByHints(page, [/post.?code/i, /zip/i],                                ATS_CONTACT.postcode);
    await fillTextByHints(page, [/linkedin/i],                                           ATS_CONTACT.linkedin);

    await fillCoverLetter(page, coverLetter);
    await answerGenericQuestions(page, config.kb);

    // Tick consent/terms checkboxes ("By continuing", "I agree", etc.) required before advancing.
    await tickConsentCheckboxes(page);

    // Try Submit then Next. Broadened selector list — PageUp tenant CSS varies widely.
    const submitBtn = page.locator(
      'button:has-text("Submit application"), button:has-text("Submit Application"), ' +
      'button:has-text("Submit"), button:has-text("Apply now"), button:has-text("Apply Now"), ' +
      'button:has-text("Send application"), button:has-text("Complete application"), ' +
      'button:has-text("Confirm and submit"), button:has-text("Finish application"), ' +
      '#submitButton, .js-submit-application, .submit-btn, ' +
      // `input[value*="Submit" i]` intentionally omitted — it can match hidden/text
      // inputs whose value happens to contain "Submit" (e.g. type="button"). The
      // `input[type="submit"]` above already covers the real submit-input case.
      'button[type="submit"], input[type="submit"], ' +
      '[data-test-id*="submit" i], [data-testid*="submit" i], [data-cy*="submit" i], ' +
      '[role="button"]:has-text("Submit")'
    ).first();
    if (await submitBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await submitBtn.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    } else {
      const advanced = await clickNext(page, ['#nextButton']);
      if (!advanced) break;
    }
  }

  await captureAndAnalyze(page, 'ats_pageup_no_submit', ctx);
  return { status: 'failed', reason: 'ats_pageup_no_submit' };
}

// SEEK OAuth "Allow access" wall shown at au.seek.com/awsk/authorize.
// Idempotent: no-op when we're not on the authorize URL.
async function handleSeekOAuthAuthorize(
  page: Page,
  ctx: { job_title?: string; company?: string },
): Promise<void> {
  const url = page.url();
  const onAuthorize = /seek\.com(?:\.au)?\/(?:awsk|oauth)\/authorize/i.test(url);
  if (!onAuthorize) return;

  const allowBtn = page.locator(
    'button:has-text("Allow access"), button:has-text("Allow"), ' +
    'button:has-text("Authorise"), button:has-text("Authorize"), ' +
    'button:has-text("Grant access"), button:has-text("Continue"), ' +
    '[data-automation*="allow" i], [data-testid*="allow" i], ' +
    'input[type="submit"][value*="Allow" i]'
  ).first();

  if (await allowBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    logger.info('ats: pageup — clicking SEEK OAuth Allow access', ctx);
    await allowBtn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  }
}

async function tickConsentCheckboxes(page: Page): Promise<void> {
  const consentRe = /by continuing|i agree|i accept|i confirm|terms|privacy|consent|acknowledge|declar(e|ation)|read and understood|conditions of use/i;
  for (const cb of await page.locator('input[type="checkbox"]').all()) {
    if (!(await cb.isVisible().catch(() => false))) continue;
    if (await cb.isChecked().catch(() => false)) continue;
    const isEnabled = await cb.isEnabled().catch(() => true);
    if (!isEnabled) continue;
    const id = await cb.getAttribute('id').catch(() => null);
    let label = '';
    if (id) label = (await page.locator(`label[for="${id}"]`).textContent().catch(() => '')) ?? '';
    if (!label) label = (await cb.evaluate((el: Element) => el.closest('label')?.textContent ?? '').catch(() => ''));
    if (!label) label = (await cb.getAttribute('aria-label').catch(() => null)) ?? '';
    if (consentRe.test(label)) {
      // Prefer clicking the associated label — many PageUp forms have covered inputs.
      if (id) {
        const lbl = page.locator(`label[for="${id}"]`);
        if (await lbl.isVisible().catch(() => false)) {
          await lbl.click().catch(() => {});
          if (await cb.isChecked().catch(() => false)) continue;
        }
      }
      await cb.click().catch(() => {});
    }
  }
}
