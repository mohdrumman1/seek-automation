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

export async function applyTeamtailor(
  page: Page,
  details: JobDetails,
  config: ApplyConfig,
  resumePath: string | null,
  coverLetter: string,
): Promise<ATSResult> {
  const ctx = { job_title: details.title, company: details.company };

  await acceptCookies(page);

  // Navigate to the application form if not already there.
  const applyBtn = page.locator(
    'a:has-text("Apply for this job"), a:has-text("Apply for"), ' +
    '[data-controller*="apply"], a[href*="/applications/new"]'
  ).first();
  if (await applyBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await applyBtn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  }

  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

  const sensitive = await hasSensitiveRequiredField(page);
  if (sensitive) {
    return { status: 'needs_manual_review', reason: `sensitive_field:${sensitive.slice(0, 60)}` };
  }

  const resolvedResume = resumePath ?? getBaseResumePath(config.resumeVariant);
  if (resolvedResume) {
    const fileInput = page.locator('input[type="file"][name*="resume" i], input[type="file"]').first();
    if (await fileInput.count() > 0) {
      await uploadResumeFile(page, resolvedResume);
      await page.waitForTimeout(2_000); // Teamtailor shows upload preview — wait for it.
    }
  }

  // Teamtailor uses a single full-name field (candidate[name]).
  const nameInput = page.locator('input[name="candidate[name]"]').first();
  if (await nameInput.count() > 0 && !(await nameInput.inputValue().catch(() => ''))) {
    await nameInput.fill(ATS_CONTACT.fullName).catch(() => {});
  }
  const emailInput = page.locator('input[name="candidate[email]"], input[type="email"]').first();
  if (await emailInput.count() > 0 && !(await emailInput.inputValue().catch(() => ''))) {
    await emailInput.fill(ATS_CONTACT.email).catch(() => {});
  }
  const phoneInput = page.locator('input[name="candidate[phone]"], input[type="tel"]').first();
  if (await phoneInput.count() > 0 && !(await phoneInput.inputValue().catch(() => ''))) {
    await phoneInput.fill(ATS_CONTACT.phone).catch(() => {});
  }

  // Fallback label hints for fields Teamtailor doesn't expose via standard names.
  await fillTextByHints(page, [/first.?name/i, /given name/i],                       ATS_CONTACT.firstName);
  await fillTextByHints(page, [/last.?name/i, /surname/i, /family name/i],            ATS_CONTACT.lastName);
  await fillTextByHints(page, [/^name$/i, /full.?name/i, /your name/i],               ATS_CONTACT.fullName);
  await fillTextByHints(page, [/e-?mail/i],                                            ATS_CONTACT.email);
  await fillTextByHints(page, [/phone/i, /mobile/i, /telephone/i],                    ATS_CONTACT.phone);
  await fillTextByHints(page, [/linkedin/i],                                           ATS_CONTACT.linkedin);

  // Cover letter textarea.
  const clInput = page.locator('textarea[name*="cover" i], textarea[name="candidate[cover_letter]"]').first();
  if (await clInput.count() > 0 && coverLetter) {
    if (!(await clInput.inputValue().catch(() => ''))) {
      await clInput.fill(coverLetter).catch(() => {});
    }
  } else {
    await fillCoverLetter(page, coverLetter);
  }

  // Employer questions.
  await answerGenericQuestions(page, config.kb);

  // GDPR consent checkbox — required to submit on Teamtailor forms.
  const consentRe = /i agree|consent|privacy|gdpr|store.{0,40}data/i;
  for (const cb of await page.locator('input[type="checkbox"]').all()) {
    if (!(await cb.isVisible().catch(() => false))) continue;
    if (await cb.isChecked().catch(() => false)) continue;
    const id = await cb.getAttribute('id').catch(() => null);
    let label = '';
    if (id) label = (await page.locator(`label[for="${id}"]`).textContent().catch(() => '')) ?? '';
    if (!label) label = (await cb.getAttribute('aria-label').catch(() => null)) ?? '';
    if (consentRe.test(label)) {
      await cb.click().catch(() => {});
    }
  }

  // Submit — Teamtailor disables the submit button until consent is ticked.
  // Scroll into view and wait for it to become enabled before clicking.
  const submitBtn = page.locator(
    'button:has-text("Send application"), button:has-text("Submit application"), ' +
    'button:has-text("Submit"), button[type="submit"]'
  ).first();
  const submitVisible = await submitBtn.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true).catch(() => false);
  if (!submitVisible) {
    await captureAndAnalyze(page, 'ats_teamtailor_no_submit', ctx);
    return { status: 'failed', reason: 'ats_teamtailor_no_submit' };
  }
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  // Wait up to 3s for the button to become enabled (consent checkbox may have just been ticked).
  await page.waitForTimeout(500);
  const isDisabled = await submitBtn.isDisabled().catch(() => false);
  if (isDisabled) {
    // Re-attempt consent check in case the first pass missed a checkbox.
    for (const cb of await page.locator('input[type="checkbox"]').all()) {
      if (!(await cb.isVisible().catch(() => false))) continue;
      if (!(await cb.isChecked().catch(() => false))) await cb.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  await submitBtn.click({ force: true }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2_000);

  if (await isSuccessPage(page, [/thanks for applying/i, /your application has been sent/i])) {
    logger.info('ats: teamtailor — applied', ctx);
    return { status: 'applied' };
  }

  await captureAndAnalyze(page, 'ats_teamtailor_no_submit', ctx);
  return { status: 'failed', reason: 'ats_teamtailor_submit_failed' };
}
