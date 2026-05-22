import { describe, it, expect, vi } from 'vitest';

// Stub openrouter before questions-kb is imported — avoids the module-level
// OPENROUTER_API_KEY guard throw in openrouter.ts.
vi.mock('../../lib/openrouter', () => ({
  callOpenRouter: vi.fn().mockResolvedValue(''),
  callOpenRouterVision: vi.fn().mockResolvedValue(''),
  tailorCoverLetter: vi.fn().mockResolvedValue(''),
}));

import { findKBAnswer } from '../../lib/questions-kb';

// Minimal in-memory KB — no disk I/O needed
const KB = [
  { keywords: ['years', 'experience', 'python'], answer: '5 years' },
  { keywords: ['salary', 'expectation'], answer: '$120,000' },
  { keywords: ['notice', 'period'], answer: '2 weeks' },
];

describe('findKBAnswer', () => {
  it('returns the stored answer when all keywords match', () => {
    expect(findKBAnswer('How many years of experience do you have with Python?', KB)).toBe('5 years');
  });

  it('returns the best-scoring entry when multiple keywords match', () => {
    // "salary" and "expectation" both match the second entry
    expect(findKBAnswer('What is your salary expectation?', KB)).toBe('$120,000');
  });

  it('returns null when no keyword matches', () => {
    expect(findKBAnswer('Do you have a driving licence?', KB)).toBeNull();
  });

  it('matching is case-insensitive', () => {
    // Keywords are lowercase; question has uppercase — should still match
    expect(findKBAnswer('NOTICE PERIOD: how long is yours?', KB)).toBe('2 weeks');
  });

  it('returns null for an empty KB', () => {
    expect(findKBAnswer('How many years of Python experience?', [])).toBeNull();
  });

  it('partial keyword overlap picks the entry with the most matches', () => {
    // "salary" alone matches KB entry 2 (score 1); "years experience" matches entry 1 (score 2)
    expect(findKBAnswer('how many years of experience?', KB)).toBe('5 years');
  });
});
