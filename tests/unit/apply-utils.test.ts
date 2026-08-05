import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/ats/index', () => ({
  applyViaATS: vi.fn(),
  detectATS: vi.fn(() => 'cornerstone'),
}));

vi.mock('../../lib/job-scraper', () => ({
  scrapeJobDetails: vi.fn().mockResolvedValue({
    title: 'Engineer', company: 'Acme', description: 'desc', location: '', salaryText: '', workType: '',
  }),
}));

vi.mock('../../lib/run-health', () => ({
  isCircuitOpen: vi.fn(() => true),
}));

vi.mock('../../lib/openrouter', () => ({
  tailorCoverLetter: vi.fn().mockResolvedValue('tailored'),
}));

vi.mock('../../lib/resume-tailor', () => ({
  tailorResume: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../lib/resume-generator', () => ({
  generateTailoredDocx: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../lib/tracker', () => ({
  deriveJobId: vi.fn(() => 'job-1'),
  recordApplication: vi.fn(),
  recordSkip: vi.fn(),
  recordFailure: vi.fn(),
}));

import { applyToSingleUrl } from '../../lib/apply-utils';
import { applyViaATS } from '../../lib/ats/index';
import { tailorCoverLetter } from '../../lib/openrouter';
import { tailorResume } from '../../lib/resume-tailor';

function makePage() {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('applyToSingleUrl: openrouter breaker gate on the direct-ATS route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips with openrouter_circuit_open and never calls tailoring or applyViaATS when the breaker is open', async () => {
    const page = makePage();
    const platform = {} as any;
    const context = {} as any;

    const result = await applyToSingleUrl(
      platform, page, context,
      'https://careers.example.com/job/123',
      [], 'base cover letter', false, 'run-1',
    );

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('openrouter_circuit_open');
    expect(tailorCoverLetter).not.toHaveBeenCalled();
    expect(tailorResume).not.toHaveBeenCalled();
    expect(applyViaATS).not.toHaveBeenCalled();
  });
});
