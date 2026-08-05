// smartrecruiters.ts has no DOM submit-button selector logic at all — SmartRecruiters
// blocks headless Chromium, so this handler just queues the job (by URL/jobId) to
// data/sr-queue.json for a later headed local run via `npm run seek-sr`. Covering it
// here for completeness of the lib/ats/*.ts sweep, but it is queueing-behavior
// coverage, not selector-regression coverage — there is no selector to test.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Page } from '@playwright/test';
import { JobDetails, ApplyConfig } from '../../../lib/platforms/types';

vi.mock('../../../lib/openrouter', () => ({
  callOpenRouter: vi.fn().mockResolvedValue(''),
  callOpenRouterVision: vi.fn().mockResolvedValue(''),
  tailorCoverLetter: vi.fn().mockResolvedValue(''),
}));

// In-memory fake of the two fs calls smartrecruiters.ts uses, so the test never
// touches the real data/sr-queue.json file on disk.
let store: Record<string, string> = {};
vi.mock('fs', () => ({
  existsSync: vi.fn((p: string) => p in store),
  readFileSync: vi.fn((p: string) => store[p]),
  writeFileSync: vi.fn((p: string, content: string) => { store[p] = content; }),
}));

import { applySmartRecruiters } from '../../../lib/ats/smartrecruiters';

function fakePage(url: string): Page {
  return { url: () => url } as unknown as Page;
}

const details: JobDetails = {
  title: 'Software Engineer',
  company: 'Acme',
  description: '',
  location: 'Sydney',
  salaryText: '',
  workType: 'Full time',
};
const config: ApplyConfig = { resumeVariant: 'se', searchName: 'test', baseCoverLetter: '', kb: [] };

describe('ats/smartrecruiters queueing', () => {
  beforeEach(() => {
    store = {};
  });

  it('returns skipped/ats_queued_sr and queues the job by URL jobId', async () => {
    const result = await applySmartRecruiters(fakePage('https://jobs.smartrecruiters.com/Acme/123456'), details, config, null, '');
    expect(result).toEqual({ status: 'skipped', reason: 'ats_queued_sr' });
    const queueFile = Object.values(store)[0];
    expect(queueFile).toBeDefined();
    const queue = JSON.parse(queueFile);
    expect(queue).toHaveLength(1);
    expect(queue[0].jobId).toBe('123456');
    expect(queue[0].title).toBe('Software Engineer');
  });

  it('does not duplicate an already-queued jobId', async () => {
    await applySmartRecruiters(fakePage('https://jobs.smartrecruiters.com/Acme/123456'), details, config, null, '');
    await applySmartRecruiters(fakePage('https://jobs.smartrecruiters.com/Acme/123456'), details, config, null, '');
    const queueFile = Object.values(store)[0];
    const queue = JSON.parse(queueFile);
    expect(queue).toHaveLength(1);
  });
});
