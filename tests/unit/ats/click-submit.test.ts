import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Page } from '@playwright/test';

vi.mock('../../../lib/openrouter', () => ({
  callOpenRouter: vi.fn().mockResolvedValue(''),
  callOpenRouterVision: vi.fn().mockResolvedValue(''),
  tailorCoverLetter: vi.fn().mockResolvedValue(''),
}));

import { clickSubmit } from '../../../lib/ats/common';
import { ApplyConfig } from '../../../lib/platforms/types';
import { newPage, closeBrowser, loadFixture } from './selector-harness';

function makeConfig(beforeSubmit?: () => Promise<boolean>): ApplyConfig {
  return {
    resumeVariant: 'pm',
    searchName: 'test',
    baseCoverLetter: '',
    kb: [],
    beforeSubmit,
  };
}

describe('ats/common clickSubmit final-submit gate', () => {
  let page: Page;

  beforeAll(async () => {
    page = await newPage();
  });

  afterAll(async () => {
    await closeBrowser();
  });

  it('returns not_found when no submit button is visible', async () => {
    await page.setContent('<html><body><div>nothing here</div></body></html>');
    const result = await clickSubmit(page, [], makeConfig(async () => true));
    expect(result).toBe('not_found');
  });

  it('clicks and returns submitted when beforeSubmit allows it', async () => {
    await page.setContent(loadFixture('cornerstone'));
    const beforeSubmit = vi.fn().mockResolvedValue(true);
    const result = await clickSubmit(page, [], makeConfig(beforeSubmit));
    expect(result).toBe('submitted');
    expect(beforeSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not click and returns daily_cap_reached when beforeSubmit denies it', async () => {
    await page.setContent('<button id="submit" type="button">Submit Application</button><script>window.submitted = false; document.querySelector("#submit").addEventListener("click", () => { window.submitted = true; });</script>');
    const beforeSubmit = vi.fn().mockResolvedValue(false);
    const result = await clickSubmit(page, [], makeConfig(beforeSubmit));
    expect(result).toBe('daily_cap_reached');
    expect(beforeSubmit).toHaveBeenCalledTimes(1);
    expect(await page.evaluate(() => (window as any).submitted)).toBe(false);
  });

  it('treats a missing beforeSubmit as always-allowed', async () => {
    await page.setContent(loadFixture('cornerstone'));
    const result = await clickSubmit(page, [], makeConfig(undefined));
    expect(result).toBe('submitted');
  });
});
