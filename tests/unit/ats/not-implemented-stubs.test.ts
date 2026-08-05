// taleo.ts, successfactors.ts, dayforce.ts, randstad.ts contain NO selector-matching
// logic — each is a stub that unconditionally returns `ats_not_implemented` without
// touching the page. There is nothing to build an HTML fixture against; these tests
// simply lock in the stub contract so a future partial implementation is a deliberate,
// visible change here rather than a silent behavior shift.
import { describe, it, expect, vi } from 'vitest';
import { Page } from '@playwright/test';

vi.mock('../../../lib/openrouter', () => ({
  callOpenRouter: vi.fn().mockResolvedValue(''),
  callOpenRouterVision: vi.fn().mockResolvedValue(''),
  tailorCoverLetter: vi.fn().mockResolvedValue(''),
}));

import { applyTaleo } from '../../../lib/ats/taleo';
import { applySuccessFactors } from '../../../lib/ats/successfactors';
import { applyDayforce } from '../../../lib/ats/dayforce';
import { applyRandstad } from '../../../lib/ats/randstad';
import { JobDetails, ApplyConfig } from '../../../lib/platforms/types';

const details: JobDetails = {
  title: 'Software Engineer',
  company: 'Acme',
  description: '',
  location: 'Sydney',
  salaryText: '',
  workType: 'Full time',
};

const config: ApplyConfig = {
  resumeVariant: 'se',
  searchName: 'test',
  baseCoverLetter: '',
  kb: [],
};

// None of these handlers touch `page` — a stub value satisfies the signature.
const fakePage = {} as Page;

describe('ats not-implemented stubs', () => {
  it('taleo: returns skipped/ats_not_implemented', async () => {
    const result = await applyTaleo(fakePage, details, config, null, '');
    expect(result).toEqual({ status: 'skipped', reason: 'ats_not_implemented' });
  });

  it('successfactors: returns skipped/ats_not_implemented', async () => {
    const result = await applySuccessFactors(fakePage, details, config, null, '');
    expect(result).toEqual({ status: 'skipped', reason: 'ats_not_implemented' });
  });

  it('dayforce: returns skipped/ats_not_implemented', async () => {
    const result = await applyDayforce(fakePage, details, config, null, '');
    expect(result).toEqual({ status: 'skipped', reason: 'ats_not_implemented' });
  });

  it('randstad: returns skipped/ats_not_implemented', async () => {
    const result = await applyRandstad(fakePage, details, config, null, '');
    expect(result).toEqual({ status: 'skipped', reason: 'ats_not_implemented' });
  });
});
