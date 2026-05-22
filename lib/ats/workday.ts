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

export async function applyWorkday(
  page: Page,
  details: JobDetails,
  config: ApplyConfig,
  resumePath: string | null,
  coverLetter: string,
): Promise<ATSResult> {
  const ctx = { job_title: details.title, company: details.company };

  await acceptCookies(page);

  // Click the top-level "Apply" button on the Workday job listing page.
  const applyBtn = page.locator(
    '[data-automation-id="adventureButton"], button:has-text("Apply for this job"), button:has-text("Apply")'
  ).first();
  if (await applyBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await applyBtn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  }

  // Check for account creation / sign-in wall.
  const wallSel =
    '[data-automation-id="createAccountLink"], [data-automation-id="signInLink"], ' +
    'a:has-text("Create Account"), button:has-text("Create Account"), ' +
    'h1:has-text("Sign In"), h2:has-text("Create an Account")';
  const hasWall = await page.locator(wallSel).first().isVisible({ timeout: 3_000 }).catch(() => false);

  if (hasWall) {
    // Prefer the "Apply Manually" guest path if offered.
    const manualBtn = page.locator(
      '[data-automation-id="applyManually"], a:has-text("Apply Manually"), button:has-text("Apply Manually")'
    ).first();
    if (await manualBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await manualBtn.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
    } else {
      logger.info('ats: workday — account wall with no manual path', ctx);
      return { status: 'skipped', reason: 'ats_requires_account' };
    }
  }

  const resolvedResume = resumePath ?? getBaseResumePath(config.resumeVariant);
  let uploadedResume = false;
  let lastUrl = '';

  // Multi-page wizard loop: fill → next → check success (up to 10 pages).
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.waitForTimeout(1_500);
    const currentUrl = page.url();

    if (await isSuccessPage(page)) {
      logger.info('ats: workday — applied', ctx);
      return { status: 'applied' };
    }

    // Account wall can reappear after navigation.
    if (await page.locator(wallSel).first().isVisible({ timeout: 1_000 }).catch(() => false)) {
      return { status: 'skipped', reason: 'ats_requires_account' };
    }

    // Stuck detection: same URL two iterations in a row and not the first.
    if (currentUrl === lastUrl && attempt > 0) {
      await captureAndAnalyze(page, 'ats_workday_no_submit', ctx);
      return { status: 'failed', reason: 'ats_workday_no_progress' };
    }
    lastUrl = currentUrl;

    // Safety gate: never fill sensitive required fields.
    const sensitive = await hasSensitiveRequiredField(page);
    if (sensitive) {
      return { status: 'needs_manual_review', reason: `sensitive_field:${sensitive.slice(0, 60)}` };
    }

    // Resume upload (only first time an upload input is present).
    if (resolvedResume && !uploadedResume) {
      const fileInput = page.locator(
        '[data-automation-id="file-upload-input-ref"], input[type="file"]'
      ).first();
      if (await fileInput.count() > 0) {
        uploadedResume = await uploadResumeFile(page, resolvedResume);
        await page.waitForTimeout(1_000);
      }
    }

    // Core identity fields via Workday-specific data-automation-id first,
    // then generic label hints as fallback.
    await fillNameAndContact(page);

    // Cover letter textarea.
    await fillCoverLetter(page, coverLetter);

    // Employer screening questions (selects, radios, checkboxes, textareas).
    await answerGenericQuestions(page, config.kb);

    // Voluntary disclosure pages — prefer "not to answer" options.
    await handleVoluntaryDisclosures(page);

    // Click the primary navigation button (Next / Save and Continue / Submit).
    const navBtn = page.locator(
      '[data-automation-id="bottom-navigation-next-button"], ' +
      'button:has-text("Save and Continue"), button:has-text("Next"), ' +
      'button:has-text("Submit"), button[type="submit"]'
    ).first();

    if (await navBtn.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await navBtn.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    } else {
      // No navigation button found — we may be stuck or done.
      break;
    }
  }

  await captureAndAnalyze(page, 'ats_workday_no_submit', ctx);
  return { status: 'failed', reason: 'ats_workday_no_submit' };
}

async function fillNameAndContact(page: Page): Promise<void> {
  // Try Workday-specific data-automation-id attributes first.
  const specific: Array<[string, string]> = [
    ['[data-automation-id="legalNameSection_firstName"]', ATS_CONTACT.firstName],
    ['[data-automation-id="legalNameSection_lastName"]',  ATS_CONTACT.lastName],
    ['[data-automation-id="email"]',                      ATS_CONTACT.email],
    ['[data-automation-id="phone-number"]',               ATS_CONTACT.phone],
  ];
  for (const [sel, value] of specific) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      if (!(await el.inputValue().catch(() => ''))) {
        await el.fill(value).catch(() => {});
      }
    }
  }

  // Generic label hints as fallback.
  await fillTextByHints(page, [/first.?name/i, /given name/i],                         ATS_CONTACT.firstName);
  await fillTextByHints(page, [/last.?name/i, /surname/i, /family name/i],              ATS_CONTACT.lastName);
  await fillTextByHints(page, [/^name$/i, /full.?name/i, /your name/i],                 ATS_CONTACT.fullName);
  await fillTextByHints(page, [/e-?mail/i],                                              ATS_CONTACT.email);
  await fillTextByHints(page, [/phone/i, /mobile/i, /contact number/i, /telephone/i],   ATS_CONTACT.phone);
  await fillTextByHints(page, [/city/i, /suburb/i, /town/i],                            ATS_CONTACT.city);
  await fillTextByHints(page, [/post.?code/i, /zip/i],                                  ATS_CONTACT.postcode);
  await fillTextByHints(page, [/linkedin/i],                                             ATS_CONTACT.linkedin);
}

// For voluntary disclosure pages (gender/race/veteran/disability) select "prefer not to answer".
async function handleVoluntaryDisclosures(page: Page): Promise<void> {
  const preferNotRe = /prefer not|decline|choose not|do not wish|not provided/i;
  for (const sel of await page.locator('select').all()) {
    if (!(await sel.isVisible().catch(() => false))) continue;
    const currentVal = await sel.inputValue().catch(() => '');
    if (currentVal) continue;
    const options = await sel.locator('option').allTextContents();
    const preferOpt = options.find((o) => preferNotRe.test(o));
    if (preferOpt) {
      await sel.selectOption({ label: preferOpt }).catch(() => {});
    }
  }
}
