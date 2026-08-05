import { Page, FrameLocator } from '@playwright/test';
import { JobDetails, ApplyConfig } from '../platforms/types';
import { ATSResult } from './types';
import {
  ATS_CONTACT, acceptCookies, fillTextByHints, fillCoverLetter,
  uploadResumeFile, getBaseResumePath, hasSensitiveRequiredField,
  answerGenericQuestions, isSuccessPage, clickNext, clickSubmit,
} from './common';
import { captureAndAnalyze } from '../error-analyzer';
import { logger } from '../logger';

// Exported for unit-test regression coverage (tests/unit/ats/cornerstone.test.ts) —
// combined with common.ts's clickSubmit() base selector list at the real call site below.
export const CORNERSTONE_SUBMIT_EXTRAS = [
  'button:has-text("Submit application")',
  'button:has-text("Apply now")',
  'button:has-text("Apply Now")',
  '[data-test-id*="submit" i]',
  '[data-testid*="submit" i]',
  '[data-cy*="submit" i]',
  '[role="button"]:has-text("Submit")',
  '#btnSubmitApplication',
  '.js-submit-application',
];

export async function applyCornerstone(
  page: Page,
  details: JobDetails,
  config: ApplyConfig,
  resumePath: string | null,
  coverLetter: string,
): Promise<ATSResult> {
  const ctx = { job_title: details.title, company: details.company };

  await acceptCookies(page);

  // CSOD may embed the form in an iframe.
  const iframeEl = page.frameLocator('iframe[src*="csod.com"]');
  const hasIframe = await page.locator('iframe[src*="csod.com"]').count() > 0;
  // We work against root (page) or the iframe root transparently.
  // For filling, we pass page and let fillTextByHints / answerGenericQuestions work on it;
  // then repeat on iframe if needed.

  // Click "Apply" button.
  const applyBtn = page.locator(
    'a:has-text("Apply"), button:has-text("Apply for"), button:has-text("Apply Now"), button:has-text("Apply")'
  ).first();
  if (await applyBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await applyBtn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  }

  // Check for account wall.
  const wallSel = 'a:has-text("Create account"), button:has-text("Create account"), h1:has-text("Create Account")';
  if (await page.locator(wallSel).first().isVisible({ timeout: 3_000 }).catch(() => false)) {
    // Look for a "continue as guest" / email path.
    const guestBtn = page.locator(
      'a:has-text("Continue as guest"), button:has-text("Continue as guest"), ' +
      'a:has-text("Apply manually"), button:has-text("Apply manually")'
    ).first();
    if (!(await guestBtn.isVisible({ timeout: 2_000 }).catch(() => false))) {
      return { status: 'skipped', reason: 'ats_requires_account' };
    }
    await guestBtn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  }

  const resolvedResume = resumePath ?? getBaseResumePath(config.resumeVariant);
  let uploadedResume = false;
  let lastUrl = '';

  for (let attempt = 0; attempt < 8; attempt++) {
    await page.waitForTimeout(1_500);
    const currentUrl = page.url();

    if (await isSuccessPage(page)) {
      logger.info('ats: cornerstone — applied', ctx);
      return { status: 'applied' };
    }

    if (currentUrl === lastUrl && attempt > 0) {
      await captureAndAnalyze(page, 'ats_cornerstone_no_submit', ctx);
      return { status: 'failed', reason: 'ats_cornerstone_no_progress' };
    }
    lastUrl = currentUrl;

    const sensitive = await hasSensitiveRequiredField(page);
    if (sensitive) {
      return { status: 'needs_manual_review', reason: `sensitive_field:${sensitive.slice(0, 60)}` };
    }

    if (resolvedResume && !uploadedResume) {
      uploadedResume = await uploadResumeFile(page, resolvedResume);
      if (hasIframe && !uploadedResume) {
        // Try iframe root.
        const iframeInput = iframeEl.locator('input[type="file"]').first();
        try {
          if (await iframeInput.count() > 0) {
            await iframeInput.setInputFiles(resolvedResume);
            await page.waitForTimeout(2_000);
            uploadedResume = true;
          }
        } catch {}
      }
    }

    await fillContact(page, iframeEl, hasIframe);
    await fillCoverLetter(page, coverLetter);
    await answerGenericQuestions(page, config.kb);

    // Try Submit first (single-page forms); fall through to Next for multi-step.
    // Broadened extras — Cornerstone CSOD uses varied button attrs across tenants.
    const submitted = await clickSubmit(page, CORNERSTONE_SUBMIT_EXTRAS);
    if (!submitted) {
      const advanced = await clickNext(page);
      if (!advanced) break;
    }
  }

  await captureAndAnalyze(page, 'ats_cornerstone_no_submit', ctx);
  return { status: 'failed', reason: 'ats_cornerstone_no_submit' };
}

async function fillContact(page: Page, _iframeEl: FrameLocator, _hasIframe: boolean): Promise<void> {
  await fillTextByHints(page, [/first.?name/i, /given name/i],                       ATS_CONTACT.firstName);
  await fillTextByHints(page, [/last.?name/i, /surname/i, /family name/i],            ATS_CONTACT.lastName);
  await fillTextByHints(page, [/^name$/i, /full.?name/i, /your name/i],               ATS_CONTACT.fullName);
  await fillTextByHints(page, [/e-?mail/i],                                            ATS_CONTACT.email);
  await fillTextByHints(page, [/phone/i, /mobile/i, /contact number/i, /telephone/i], ATS_CONTACT.phone);
  await fillTextByHints(page, [/city/i, /suburb/i, /town/i],                          ATS_CONTACT.city);
  await fillTextByHints(page, [/post.?code/i, /zip/i],                                ATS_CONTACT.postcode);
  await fillTextByHints(page, [/linkedin/i],                                           ATS_CONTACT.linkedin);
}
