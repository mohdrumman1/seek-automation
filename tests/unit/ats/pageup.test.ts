import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Page } from '@playwright/test';

// Stub openrouter before pageup.ts (via lib/ats/common.ts -> lib/questions-kb.ts) is
// imported — avoids the module-level OPENROUTER_API_KEY guard throw in openrouter.ts.
// Same pattern as tests/unit/kb.test.ts and tests/unit/select-best-option.test.ts.
vi.mock('../../../lib/openrouter', () => ({
  callOpenRouter: vi.fn().mockResolvedValue(''),
  callOpenRouterVision: vi.fn().mockResolvedValue(''),
  tailorCoverLetter: vi.fn().mockResolvedValue(''),
}));

import { PAGEUP_SUBMIT_SELECTOR } from '../../../lib/ats/pageup';
import { newPage, closeBrowser, loadFixture, selectorFindsVisibleMatch } from './selector-harness';

// The old, narrower selector in place before commit 54692cb (2026-07-01 audit fix).
// Kept here (not imported — it no longer exists in source) purely to prove the
// negative fixture below is a genuine regression case, not just a match on
// current code.
const OLD_PAGEUP_SUBMIT_SELECTOR = 'button:has-text("Submit"), #submitButton, input[value*="Submit" i]';

describe('ats/pageup submit-button selector', () => {
  let page: Page;

  beforeAll(async () => {
    page = await newPage();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  it('finds the standard "Submit Application" button', async () => {
    const html = loadFixture('pageup');
    expect(await selectorFindsVisibleMatch(page, html, PAGEUP_SUBMIT_SELECTOR)).toBe(true);
  });

  it('regression: finds "Send application" with data-test-id (2026-07-01 incident) — old selector missed it', async () => {
    const html = loadFixture('pageup-negative');
    expect(await selectorFindsVisibleMatch(page, html, OLD_PAGEUP_SUBMIT_SELECTOR)).toBe(false);
    expect(await selectorFindsVisibleMatch(page, html, PAGEUP_SUBMIT_SELECTOR)).toBe(true);
  });
});
