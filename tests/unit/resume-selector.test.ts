import { describe, it, expect } from 'vitest';
import {
  PLACEHOLDER_RE,
  isPlaceholderLabel,
  pickResumeIndex,
} from '../../lib/resume-selector';

describe('PLACEHOLDER_RE / isPlaceholderLabel', () => {
  it('matches "Please select a resumé" (accented é — the SEEK case)', () => {
    expect(PLACEHOLDER_RE.test('Please select a resumé')).toBe(true);
    expect(isPlaceholderLabel('Please select a resumé')).toBe(true);
  });

  it('matches "Please select a resume" (no accent)', () => {
    expect(PLACEHOLDER_RE.test('Please select a resume')).toBe(true);
    expect(isPlaceholderLabel('Please select a resume')).toBe(true);
  });

  it('matches "--" and "---Select---" dash-style placeholders', () => {
    expect(PLACEHOLDER_RE.test('--')).toBe(true);
    expect(PLACEHOLDER_RE.test('---Select---')).toBe(true);
    expect(isPlaceholderLabel('--')).toBe(true);
    expect(isPlaceholderLabel('---Select---')).toBe(true);
  });

  it('matches empty / whitespace-only labels', () => {
    expect(isPlaceholderLabel('')).toBe(true);
    expect(isPlaceholderLabel('   ')).toBe(true);
  });

  it('does NOT flag a real resume filename as a placeholder', () => {
    expect(PLACEHOLDER_RE.test('Rumman_ACME_2026-05-01.docx')).toBe(false);
    expect(isPlaceholderLabel('Rumman_ACME_2026-05-01.docx')).toBe(false);
  });

  it('does NOT flag Base_Resume.docx as a placeholder', () => {
    expect(PLACEHOLDER_RE.test('Base_Resume.docx')).toBe(false);
    expect(isPlaceholderLabel('Base_Resume.docx')).toBe(false);
  });
});

describe('pickResumeIndex', () => {
  it('skips the placeholder at index 0 and returns the first real option (regression: P2 fallback)', () => {
    // No keyword match — must land on index 1, not index 0.
    const options = ['Please select a resumé', 'Base_Resume.docx'];
    expect(pickResumeIndex(options, 'se')).toBe(1);
  });

  it('picks the keyword-matched option when the variant scores higher on a real entry', () => {
    // "Rumman_ACME_2026-05-01.docx" scores 0 on SE keywords, but the second
    // real option contains "software" & "engineer" so it should win.
    const options = [
      'Please select a resumé',
      'Rumman_ACME_2026-05-01.docx',
      'Rumman_Software_Engineer.docx',
    ];
    expect(pickResumeIndex(options, 'se')).toBe(2);
  });

  it('picks the PM-scoring option when the variant is pm', () => {
    const options = [
      'Please select a resumé',
      'Rumman_SE.docx',
      'Rumman_Project_Manager.docx',
    ];
    expect(pickResumeIndex(options, 'pm')).toBe(2);
  });

  it('throws resume_no_valid_option when the only option is a placeholder', () => {
    expect(() => pickResumeIndex(['Please select a resumé'], 'se')).toThrowError(
      'resume_no_valid_option',
    );
  });

  it('returns index 0 when the only option is a real resume (no placeholder)', () => {
    expect(pickResumeIndex(['Base_Resume.docx'], 'se')).toBe(0);
  });

  it('throws resume_no_valid_option when the options array is empty', () => {
    expect(() => pickResumeIndex([], 'se')).toThrowError('resume_no_valid_option');
  });

  it('throws resume_no_valid_option when every option is a placeholder', () => {
    expect(() =>
      pickResumeIndex(['--', 'Please select a resumé', '   '], 'se'),
    ).toThrowError('resume_no_valid_option');
  });
});
