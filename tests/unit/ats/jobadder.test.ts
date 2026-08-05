import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Page } from '@playwright/test';

vi.mock('../../../lib/openrouter', () => ({
  callOpenRouter: vi.fn().mockResolvedValue(''),
  callOpenRouterVision: vi.fn().mockResolvedValue(''),
  tailorCoverLetter: vi.fn().mockResolvedValue(''),
}));

import { JOBADDER_SUBMIT_SELECTOR } from '../../../lib/ats/jobadder';
import { newPage, closeBrowser, loadFixture, selectorFindsVisibleMatch } from './selector-harness';

// The old, narrower selector in place before commit 54692cb (2026-07-01 audit fix).
const OLD_JOBADDER_SUBMIT_SELECTOR =
  'button:has-text("Submit application"), button:has-text("Submit Application"), ' +
  'button:has-text("Apply"), button[type="submit"]';

describe('ats/jobadder submit-button selector', () => {
  let page: Page;

  beforeAll(async () => {
    page = await newPage();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  it('finds the standard "Submit Application" button', async () => {
    const html = loadFixture('jobadder');
    expect(await selectorFindsVisibleMatch(page, html, JOBADDER_SUBMIT_SELECTOR)).toBe(true);
  });

  it('regression: finds native input[type=submit] (2026-07-01 incident) — old selector missed it', async () => {
    const html = loadFixture('jobadder-negative');
    expect(await selectorFindsVisibleMatch(page, html, OLD_JOBADDER_SUBMIT_SELECTOR)).toBe(false);
    expect(await selectorFindsVisibleMatch(page, html, JOBADDER_SUBMIT_SELECTOR)).toBe(true);
  });
});
