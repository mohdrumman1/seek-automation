// Shared Playwright-driven harness for ATS submit-button selector regression tests.
//
// Why Playwright and not jsdom: every ATS handler's selector strings use
// Playwright-only pseudo-classes (`:has-text()`, `[role="button"]:has-text()`)
// that jsdom/CSS.escape cannot evaluate. Loading a real (headless) page via
// `page.setContent()` and running the *exact* selector string the handler code
// uses is the only way to test the real matching logic rather than a reimplementation
// of it. This mirrors how tests/example.spec.ts and tests/integration/dry-run.spec.ts
// already use @playwright/test browsers — no new testing approach introduced.
import * as fs from 'fs';
import * as path from 'path';
import { chromium, Browser, Page } from '@playwright/test';

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch();
  }
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

export async function newPage(): Promise<Page> {
  const b = await getBrowser();
  return b.newPage();
}

// name is the fixture filename without extension, e.g. "pageup" or "pageup-negative".
export function loadFixture(name: string): string {
  const p = path.resolve(__dirname, '../../fixtures/ats', `${name}.html`);
  return fs.readFileSync(p, 'utf-8');
}

// Load HTML into a fresh page and report whether the given selector's
// `.first()` locator resolves to a *visible* element — matching how every
// ATS handler gates its click (`isVisible({ timeout })`).
export async function selectorFindsVisibleMatch(
  page: Page,
  html: string,
  selector: string,
): Promise<boolean> {
  await page.setContent(html);
  return page.locator(selector).first().isVisible().catch(() => false);
}
