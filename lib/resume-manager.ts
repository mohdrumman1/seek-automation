import { Page } from '@playwright/test';
import { logger } from './logger';

// SEEK allows a maximum of 5 saved documents. We name tailored resumes
// "tailored-*" so they can be identified and deleted before each run,
// leaving slots free for the base PM/SE resumes.
const PROFILE_DOCS_URL = 'https://www.seek.com.au/profile/documents';

export async function cleanTailoredResumes(page: Page): Promise<void> {
  try {
    await page.goto(PROFILE_DOCS_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(2_000);

    // SEEK renders documents as list items. Look for any entry whose visible
    // text starts with "tailored-" and click its delete button.
    let deleted = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      // Find a document card/row whose title contains "tailored-"
      const docEntry = page.locator(
        '[data-automation*="document"], [data-testid*="document"], li, article'
      ).filter({ hasText: /tailored-/i }).first();

      if (!(await docEntry.isVisible({ timeout: 2_000 }).catch(() => false))) break;

      // Click the delete/remove button within that entry
      const deleteBtn = docEntry.locator(
        'button[aria-label*="delete" i], button[aria-label*="remove" i], button:has-text("Delete"), button:has-text("Remove")'
      ).first();

      if (!(await deleteBtn.isVisible({ timeout: 2_000 }).catch(() => false))) {
        // Fallback: look for a "..." or options menu, then delete
        const optionsBtn = docEntry.locator('button').last();
        await optionsBtn.click().catch(() => {});
        await page.waitForTimeout(500);
        const menuDelete = page.locator(
          '[role="menuitem"]:has-text("Delete"), [role="menuitem"]:has-text("Remove")'
        ).first();
        if (await menuDelete.isVisible({ timeout: 1_500 }).catch(() => false)) {
          await menuDelete.click().catch(() => {});
        } else {
          break;
        }
      } else {
        await deleteBtn.click().catch(() => {});
      }

      // Confirm deletion if a dialog appears
      await page.waitForTimeout(800);
      const confirmBtn = page.locator(
        'button:has-text("Confirm"), button:has-text("Yes"), button:has-text("Delete"), [data-automation*="confirm"]'
      ).first();
      if (await confirmBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await confirmBtn.click().catch(() => {});
        await page.waitForTimeout(800);
      }

      deleted++;
    }

    if (deleted > 0) {
      logger.info('resume-manager: deleted tailored resumes from SEEK profile', { deleted });
    }
  } catch (err) {
    // Non-fatal — if cleanup fails, the run still proceeds.
    // If SEEK's document limit is hit during the run, uploadTailoredResume
    // handles it by falling back to the existing dropdown selection.
    logger.warn('resume-manager: cleanup failed (non-fatal)', { error: String(err) });
  }
}

export async function uploadTailoredResume(
  page: Page,
  filePath: string,
): Promise<boolean> {
  // Option 1: radio button to switch to "upload new document" mode
  const uploadRadio = page.locator(
    'input[name="resume-method"][value="upload"], input[name="resume-method"][value="new"]'
  );
  if (await uploadRadio.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
    await uploadRadio.first().click();
    await page.waitForTimeout(500);
  }

  // Option 2: "Upload new document" / "Upload resume" button
  const uploadBtn = page.locator(
    'button:has-text("Upload"), a:has-text("Upload"), [data-automation*="upload"]'
  ).filter({ hasNotText: /uploaded/i }).first();
  if (await uploadBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await uploadBtn.click().catch(() => {});
    await page.waitForTimeout(500);
  }

  // Find the file input (may appear after clicking Upload button)
  const fileInput = page.locator('input[type="file"]').first();
  if (!(await fileInput.isVisible({ timeout: 5_000 }).catch(() => false))) {
    // Some browsers hide the file input — try to make it visible
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="file"]');
      inputs.forEach((el) => {
        (el as HTMLElement).style.display = 'block';
        (el as HTMLElement).style.opacity = '1';
      });
    });
    await page.waitForTimeout(300);
  }

  try {
    await fileInput.setInputFiles(filePath);
    await page.waitForTimeout(2_000);
    logger.info('resume-manager: tailored resume uploaded', { file: filePath });
    return true;
  } catch (err) {
    logger.warn('resume-manager: file upload failed', { file: filePath, error: String(err) });
    return false;
  }
}
