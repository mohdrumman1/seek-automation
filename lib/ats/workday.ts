import { Page } from '@playwright/test';
import { JobDetails, ApplyConfig } from '../platforms/types';
import { ATSResult } from './types';
import {
  ATS_CONTACT, acceptCookies, fillTextByHints, fillCoverLetter,
  uploadResumeFile, getBaseResumePath, hasSensitiveRequiredField,
  answerGenericQuestions, isSuccessPage, getQuestionLabel,
} from './common';
import { captureAndAnalyze } from '../error-analyzer';
import { logger } from '../logger';

const WALL_SEL =
  '[data-automation-id="createAccountLink"], [data-automation-id="signInLink"], ' +
  'a:has-text("Create Account"), button:has-text("Create Account"), ' +
  'h1:has-text("Sign In"), h2:has-text("Create an Account")';

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

  // "Start Your Application" modal — Workday shows this for tenants that support
  // resumé autofill, LinkedIn, or prior-application reuse. Prefer the guest/manual
  // path. "Use My Last Application" is the next best option (avoids re-entering data).
  await dismissStartYourApplicationModal(page);

  // Check for account creation / sign-in wall.
  const hasWall = await page.locator(WALL_SEL).first().isVisible({ timeout: 3_000 }).catch(() => false);

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
      // No guest path — sign in with existing account or create a new one.
      const accountResult = await signInOrCreateAccount(page, ctx);
      if (accountResult === 'verify_email') {
        await captureAndAnalyze(page, 'ats_workday_verify_email', ctx);
        return { status: 'needs_manual_review', reason: 'workday_account_verify_email' };
      }
      if (accountResult !== 'ok') {
        await captureAndAnalyze(page, 'ats_workday_account_failed', ctx);
        return { status: 'skipped', reason: 'ats_requires_account' };
      }
      // After sign-in Workday sometimes redirects back to the job listing — click Apply again.
      if (await applyBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await applyBtn.click().catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1_000);
      }
    }
  }

  const resolvedResume = resumePath ?? getBaseResumePath(config.resumeVariant);
  let uploadedResume = false;
  let lastUrl = '';

  // Multi-page wizard loop: fill → next → check success (up to 10 pages).
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.waitForTimeout(1_500);
    const currentUrl = page.url();

    // Modal can reappear after sign-in redirects back to the listing page.
    await dismissStartYourApplicationModal(page);

    if (await isSuccessPage(page)) {
      logger.info('ats: workday — applied', ctx);
      return { status: 'applied' };
    }

    // Account wall can reappear after navigation (different Workday tenant behaviour).
    if (await page.locator(WALL_SEL).first().isVisible({ timeout: 1_000 }).catch(() => false)) {
      await captureAndAnalyze(page, 'ats_workday_wall_mid_apply', ctx);
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
      await captureAndAnalyze(page, 'ats_workday_sensitive_field', ctx);
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
      // No navigation button found — capture for debugging.
      await captureAndAnalyze(page, 'ats_workday_no_nav_button', ctx);
      break;
    }
  }

  await captureAndAnalyze(page, 'ats_workday_no_submit', ctx);
  return { status: 'failed', reason: 'ats_workday_no_submit' };
}

// Handles the "Start Your Application" modal that Workday shows before the wizard.
// Preference order: Apply Manually (guest) → Use My Last Application → Autofill with Resume.
async function dismissStartYourApplicationModal(page: Page): Promise<void> {
  const candidates = [
    'button:has-text("Apply Manually")',
    '[data-automation-id="applyManually"]',
    'button:has-text("Use My Last Application")',
    'button:has-text("Autofill with Resume")',
  ];
  for (const sel of candidates) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      return;
    }
  }
}

// Sign in with existing credentials, or create a new account if needed.
// Returns: 'ok' (ready to apply), 'verify_email' (need to verify inbox), 'failed' (unrecoverable).
async function signInOrCreateAccount(
  page: Page,
  ctx: { job_title?: string; company?: string },
): Promise<'ok' | 'verify_email' | 'failed'> {
  const pwd = process.env.WORKDAY_PASSWORD ?? '';

  // ── Try Sign In first (account may already exist from a prior run) ─────────
  const signInLink = page.locator(
    '[data-automation-id="signInLink"], a:has-text("Sign In"), button:has-text("Sign In")'
  ).first();

  if (await signInLink.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await signInLink.click().catch(() => {});
    await page.waitForTimeout(1_500);

    const emailField = page.locator(
      '[data-automation-id="signInEmail"], input[autocomplete="username"], input[type="email"]'
    ).first();
    const passField = page.locator(
      '[data-automation-id="password"], input[type="password"]'
    ).first();

    if (await emailField.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await emailField.fill(ATS_CONTACT.email).catch(() => {});
    }
    if (await passField.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await passField.fill(pwd).catch(() => {});
    }

    const signInSubmit = page.locator(
      '[data-automation-id="signInSubmitButton"], ' +
      'button:has-text("Sign In"):not([data-automation-id="signInLink"]), ' +
      'input[type="submit"][value*="Sign In" i]'
    ).first();
    if (await signInSubmit.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await signInSubmit.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
    }

    const hasError = await page.locator(
      '[data-automation-id="signInGlobalErrorMessage"], ' +
      '[role="alert"]:has-text("incorrect"), [role="alert"]:has-text("invalid")'
    ).first().isVisible({ timeout: 2_000 }).catch(() => false);
    const stillOnSignIn = await page.locator(
      '[data-automation-id="signInSubmitButton"]'
    ).isVisible({ timeout: 1_000 }).catch(() => false);

    if (!hasError && !stillOnSignIn) {
      logger.info('ats: workday — signed in to existing account', ctx);
      return 'ok';
    }
    logger.info('ats: workday — sign in failed, trying create account', ctx);
  }

  // ── Try Create Account ─────────────────────────────────────────────────────
  const createLink = page.locator(
    '[data-automation-id="createAccountLink"], ' +
    'a:has-text("Create Account"), button:has-text("Create Account"), ' +
    'a:has-text("Create an Account"), button:has-text("Create an Account")'
  ).first();

  if (!await createLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
    logger.warn('ats: workday — no sign-in or create-account option found', ctx);
    return 'failed';
  }

  await createLink.click().catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1_500);

  // Fill registration form.
  await fillTextByHints(page, [/e-?mail/i, /username/i], ATS_CONTACT.email);
  await fillTextByHints(page, [/verify.{0,10}email|confirm.{0,10}email|re.?enter.{0,10}email/i], ATS_CONTACT.email);
  await fillTextByHints(page, [/first.?name|given name/i], ATS_CONTACT.firstName);
  await fillTextByHints(page, [/last.?name|surname|family name/i], ATS_CONTACT.lastName);

  // Fill all password inputs (password + confirm-password).
  for (const inp of await page.locator('input[type="password"]').all()) {
    if (!(await inp.isVisible().catch(() => false))) continue;
    const existing = await inp.inputValue().catch(() => '');
    if (!existing) await inp.fill(pwd).catch(() => {});
  }

  // Tick any terms / privacy checkboxes required to enable the submit button.
  for (const cb of await page.locator('input[type="checkbox"]').all()) {
    if (!(await cb.isVisible().catch(() => false))) continue;
    if (await cb.isChecked().catch(() => false)) continue;
    const id = await cb.getAttribute('id').catch(() => null);
    let cbLabel = '';
    if (id) cbLabel = (await page.locator(`label[for="${id}"]`).textContent().catch(() => '')) ?? '';
    if (!cbLabel) {
      cbLabel = await cb.evaluate((el: Element) => el.closest('label')?.textContent ?? '').catch(() => '');
    }
    if (/terms|privacy|consent|agree/i.test(cbLabel)) {
      await cb.click().catch(() => {});
    }
  }

  const submitBtn = page.locator(
    '[data-automation-id="createAccountSubmitButton"], ' +
    'button:has-text("Create Account"), ' +
    'button[type="submit"]:has-text("Create"), ' +
    'input[type="submit"][value*="Create" i]'
  ).first();
  if (await submitBtn.isVisible({ timeout: 4_000 }).catch(() => false)) {
    await submitBtn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
  }

  // Email verification gate — user must click the link in mohdrumman1@gmail.com.
  const verifyGate = await page.locator(
    'text=/verify your email/i, text=/check your email/i, text=/confirmation email/i, ' +
    'text=/email has been sent/i'
  ).first().isVisible({ timeout: 3_000 }).catch(() => false);
  if (verifyGate) {
    logger.info('ats: workday — account created but email verification required (check mohdrumman1@gmail.com)', ctx);
    return 'verify_email';
  }

  // Any error shown on the page means account creation failed.
  const createError = await page.locator(
    '[data-automation-id="createAccountError"], [role="alert"], .error-message'
  ).first().isVisible({ timeout: 2_000 }).catch(() => false);
  if (createError) {
    logger.warn('ats: workday — create account error on page', ctx);
    return 'failed';
  }

  logger.info('ats: workday — new account created successfully', ctx);
  return 'ok';
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
