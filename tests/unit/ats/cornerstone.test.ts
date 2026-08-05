import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Page } from '@playwright/test';

vi.mock('../../../lib/openrouter', () => ({
  callOpenRouter: vi.fn().mockResolvedValue(''),
  callOpenRouterVision: vi.fn().mockResolvedValue(''),
  tailorCoverLetter: vi.fn().mockResolvedValue(''),
}));

import { CORNERSTONE_SUBMIT_EXTRAS } from '../../../lib/ats/cornerstone';
import { CLICK_SUBMIT_BASE_SELECTORS } from '../../../lib/ats/common';
import { newPage, closeBrowser, loadFixture, selectorFindsVisibleMatch } from './selector-harness';

// clickSubmit(page, extras) in common.ts builds its final selector list as
// [...extras, ...CLICK_SUBMIT_BASE_SELECTORS] — replicate that exactly here.
const CORNERSTONE_SUBMIT_SELECTOR = [...CORNERSTONE_SUBMIT_EXTRAS, ...CLICK_SUBMIT_BASE_SELECTORS].join(', ');

// The old call site (`clickSubmit(page)`, no extras) before commit 54692cb — only
// the common.ts base list applied.
const OLD_CORNERSTONE_SUBMIT_SELECTOR = CLICK_SUBMIT_BASE_SELECTORS.join(', ');

describe('ats/cornerstone submit-button selector', () => {
  let page: Page;

  beforeAll(async () => {
    page = await newPage();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  it('finds the standard "Submit" button', async () => {
    const html = loadFixture('cornerstone');
    expect(await selectorFindsVisibleMatch(page, html, CORNERSTONE_SUBMIT_SELECTOR)).toBe(true);
  });

  it('regression: finds "Apply now" / #btnSubmitApplication (2026-07-01 incident) — old selector missed it', async () => {
    const html = loadFixture('cornerstone-negative');
    expect(await selectorFindsVisibleMatch(page, html, OLD_CORNERSTONE_SUBMIT_SELECTOR)).toBe(false);
    expect(await selectorFindsVisibleMatch(page, html, CORNERSTONE_SUBMIT_SELECTOR)).toBe(true);
  });
});
