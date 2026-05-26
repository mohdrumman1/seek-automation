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

  // Click the Apply/Begin button.
  const applyBtn = page.locator(
    'button:has-text("Apply"), button:has-text("Begin application"), ' +
    'a:has-text("Apply"), a:has-text("Begin")'
  ).first();
  if (await applyBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await applyBtn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
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

    // hCaptcha challenge page ("Uh oh... It looks like something has gone wrong" + CAPTCHA).
    // Bail immediately — we cannot solve CAPTCHAs and looping just wastes time.
    const hasHCaptcha = await page.locator('iframe[src*="hcaptcha"], .h-captcha, #hcaptcha').first()
      .isVisible({ timeout: 500 }).catch(() => false);
    if (hasHCaptcha) {
      logger.info('ats: pageup — hCaptcha detected, skipping', ctx);
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

    // Try Submit then Next.
    const submitBtn = page.locator(
      'button:has-text("Submit"), #submitButton, input[value*="Submit" i]'
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

async function tickConsentCheckboxes(page: Page): Promise<void> {
  const consentRe = /by continuing|i agree|i accept|terms|privacy|consent|acknowledge/i;
  for (const cb of await page.locator('input[type="checkbox"]').all()) {
    if (!(await cb.isVisible().catch(() => false))) continue;
    if (await cb.isChecked().catch(() => false)) continue;
    const id = await cb.getAttribute('id').catch(() => null);
    let label = '';
    if (id) label = (await page.locator(`label[for="${id}"]`).textContent().catch(() => '')) ?? '';
    if (!label) label = (await cb.evaluate((el: Element) => el.closest('label')?.textContent ?? '').catch(() => ''));
    if (consentRe.test(label)) {
      await cb.click().catch(() => {});
    }
  }
}
