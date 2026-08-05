import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Page } from '@playwright/test';

vi.mock('../../../lib/openrouter', () => ({
  callOpenRouter: vi.fn().mockResolvedValue(''),
  callOpenRouterVision: vi.fn().mockResolvedValue(''),
  tailorCoverLetter: vi.fn().mockResolvedValue(''),
}));

import { WORKDAY_NAV_SELECTOR } from '../../../lib/ats/workday';
import { newPage, closeBrowser, loadFixture, selectorFindsVisibleMatch } from './selector-harness';

// The old, narrower selector in place before commit 54692cb (2026-07-01 audit fix).
const OLD_WORKDAY_NAV_SELECTOR =
  '[data-automation-id="bottom-navigation-next-button"], ' +
  'button:has-text("Save and Continue"), button:has-text("Next"), ' +
  'button:has-text("Submit"), button[type="submit"]';

describe('ats/workday nav/submit-button selector', () => {
  let page: Page;

  beforeAll(async () => {
    page = await newPage();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  it('finds the standard bottom-navigation-next-button', async () => {
    const html = loadFixture('workday');
    expect(await selectorFindsVisibleMatch(page, html, WORKDAY_NAV_SELECTOR)).toBe(true);
  });

  it('regression: finds wd-CommandButton_uic_okButton (2026-07-01 incident) — old selector missed it', async () => {
    const html = loadFixture('workday-negative');
    expect(await selectorFindsVisibleMatch(page, html, OLD_WORKDAY_NAV_SELECTOR)).toBe(false);
    expect(await selectorFindsVisibleMatch(page, html, WORKDAY_NAV_SELECTOR)).toBe(true);
  });
});
