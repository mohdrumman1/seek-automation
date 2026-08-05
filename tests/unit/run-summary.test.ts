import { describe, it, expect } from 'vitest';
import { computeRunStatus } from '../../lib/run-summary';

describe('computeRunStatus', () => {
  it('is OK when the run succeeded and no zero-result streak', () => {
    expect(computeRunStatus(false, 0)).toBe('OK');
  });

  it('is WARN at 1-2 consecutive zero-result runs', () => {
    expect(computeRunStatus(false, 1)).toBe('WARN');
    expect(computeRunStatus(false, 2)).toBe('WARN');
  });

  it('is FAIL at 3+ consecutive zero-result runs', () => {
    expect(computeRunStatus(false, 3)).toBe('FAIL');
    expect(computeRunStatus(false, 5)).toBe('FAIL');
  });

  it('is FAIL when the run itself failed, regardless of streak', () => {
    expect(computeRunStatus(true, 0)).toBe('FAIL');
    expect(computeRunStatus(true, 1)).toBe('FAIL');
  });
});
