import { describe, it, expect } from 'vitest';
import { detectATS } from '../../lib/ats/detect';

describe('detectATS', () => {
  it('detects workday', () => expect(detectATS('https://mycompany.myworkdayjobs.com/en-US/jobs/job/123')).toBe('workday'));
  it('detects cornerstone', () => expect(detectATS('https://mycompany.csod.com/ux/ats/careersite/1/home')).toBe('cornerstone'));
  it('detects jobadder', () => expect(detectATS('https://apply.jobadder.com/123/456')).toBe('jobadder'));
  it('detects teamtailor', () => expect(detectATS('https://jobs.teamtailor.com/companies/myco/jobs/123')).toBe('teamtailor'));
  it('detects pageup', () => expect(detectATS('https://myco.pageuppeople.com/apply/123')).toBe('pageup'));
  it('returns null for seek url', () => expect(detectATS('https://www.seek.com.au/job/81234567')).toBeNull());
  it('is case-insensitive for workday', () => expect(detectATS('https://MYCOMPANY.MYWORKDAYJOBS.COM/jobs/123')).toBe('workday'));
});
