import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Page } from '@playwright/test';

vi.mock('../../../lib/openrouter', () => ({
  callOpenRouter: vi.fn().mockResolvedValue(''),
  callOpenRouterVision: vi.fn().mockResolvedValue(''),
  tailorCoverLetter: vi.fn().mockResolvedValue(''),
}));

import { TEAMTAILOR_SUBMIT_SELECTOR } from '../../../lib/ats/teamtailor';
import { newPage, closeBrowser, loadFixture, selectorFindsVisibleMatch } from './selector-harness';

// The old, narrower selector in place before commit 54692cb (2026-07-01 audit fix).
const OLD_TEAMTAILOR_SUBMIT_SELECTOR =
  'button:has-text("Send application"), button:has-text("Submit application"), ' +
  'button:has-text("Submit"), button[type="submit"]';

describe('ats/teamtailor submit-button selector', () => {
  let page: Page;

  beforeAll(async () => {
    page = await newPage();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  it('finds the standard "Send application" button', async () => {
    const html = loadFixture('teamtailor');
    expect(await selectorFindsVisibleMatch(page, html, TEAMTAILOR_SUBMIT_SELECTOR)).toBe(true);
  });

  it('regression: finds native input[type=submit] (2026-07-01 incident) — old selector missed it', async () => {
    const html = loadFixture('teamtailor-negative');
    expect(await selectorFindsVisibleMatch(page, html, OLD_TEAMTAILOR_SUBMIT_SELECTOR)).toBe(false);
    expect(await selectorFindsVisibleMatch(page, html, TEAMTAILOR_SUBMIT_SELECTOR)).toBe(true);
  });
});
