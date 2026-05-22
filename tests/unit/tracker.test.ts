import { describe, it, expect } from 'vitest';
import { escapeCsv } from '../../lib/tracker';

describe('escapeCsv', () => {
  it('passes through a plain value unchanged', () => {
    expect(escapeCsv('hello')).toBe('hello');
  });

  it('wraps value with comma in double quotes', () => {
    expect(escapeCsv('a,b')).toBe('"a,b"');
  });

  it('doubles embedded double quotes and wraps in quotes', () => {
    expect(escapeCsv('say "hi"')).toBe('"say ""hi"""');
  });

  it('wraps value containing a newline in double quotes', () => {
    const result = escapeCsv('line1\nline2');
    expect(result).toBe('"line1\nline2"');
  });

  it('wraps value containing a carriage return in double quotes', () => {
    const result = escapeCsv('line1\rline2');
    expect(result).toBe('"line1\rline2"');
  });

  it('converts null to empty string', () => {
    expect(escapeCsv(null)).toBe('');
  });

  it('converts undefined to empty string', () => {
    expect(escapeCsv(undefined)).toBe('');
  });

  it('converts numeric value to its string representation', () => {
    expect(escapeCsv(42)).toBe('42');
  });
});
