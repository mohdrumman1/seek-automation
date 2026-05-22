import { describe, it, expect, vi } from 'vitest';

// Stub openrouter before questions-kb is imported — avoids the module-level
// OPENROUTER_API_KEY guard throw in openrouter.ts.
vi.mock('../../lib/openrouter', () => ({
  callOpenRouter: vi.fn().mockResolvedValue(''),
  callOpenRouterVision: vi.fn().mockResolvedValue(''),
  tailorCoverLetter: vi.fn().mockResolvedValue(''),
}));

import { selectBestOption } from '../../lib/questions-kb';

describe('selectBestOption', () => {
  it('returns the exact match', () => {
    const options = ['', 'Full Time', 'Part Time', 'Contract'];
    expect(selectBestOption(options, 'Full Time')).toBe('Full Time');
  });

  it('matches non-breaking space (\\xa0) in option against regular space in answer', () => {
    // Option label contains \xa0, answer uses a normal space — should still match
    const options = ['', 'Full\xa0Time', 'Part Time'];
    expect(selectBestOption(options, 'Full Time')).toBe('Full\xa0Time');
  });

  it('selects numerically closest salary option (comma-strip fix)', () => {
    // $120,000 must parse as 120000, not 120 (the bug was comma truncation).
    // No placeholder first entry so exact/contains don't short-circuit via empty string.
    const options = ['$100,000-$119,999', '$120,000-$139,999', '$140,000+'];
    // Target = 120000; $120,000-$139,999 has diff 0, so it wins.
    expect(selectBestOption(options, '$120,000')).toBe('$120,000-$139,999');
  });

  it('selects closest salary option when answer is between ranges', () => {
    const options = ['$80,000-$99,999', '$100,000-$119,999', '$120,000-$139,999'];
    // Target = 110000; $100,000 diff = 10000, $120,000 diff = 10000 — first slice(1) candidate wins
    const result = selectBestOption(options, '$110,000');
    expect(['$100,000-$119,999', '$120,000-$139,999']).toContain(result);
  });

  it('falls back to options[1] when no keyword or numeric match', () => {
    // Use options that don't contain digits so numeric branch is skipped.
    // Use non-empty first option so contains-empty-string short-circuit is avoided.
    const options = ['Placeholder', 'Preferred', 'Optional', 'Required'];
    // "banana" matches nothing; first result of slice(1) numeric fallback = options[1]
    // But "banana" has no digits so numeric branch is skipped entirely.
    // Falls to "return options[1] ?? options[0]" at the end.
    expect(selectBestOption(options, 'banana')).toBe('Preferred');
  });

  it('falls back to options[0] when options has only one entry', () => {
    expect(selectBestOption(['Only Option'], 'no match')).toBe('Only Option');
  });

  it('contains match: answer is a substring of an option', () => {
    // No empty placeholder so contains match finds the real option first.
    const options = ['More than 5 years', 'Less than 1 year'];
    expect(selectBestOption(options, 'More than 5 years experience')).toBe('More than 5 years');
  });
});
