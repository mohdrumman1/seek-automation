import { ATSProvider } from './types';

// Ordered list of [substring, provider]. First match wins.
// Substrings are matched against the full lower-cased URL.
const ATS_PATTERNS: Array<[string, ATSProvider]> = [
  ['myworkdayjobs.com',   'workday'],
  ['myworkdaysite.com',   'workday'],
  ['.wd1.',              'workday'],
  ['.wd3.',              'workday'],
  ['.wd5.',              'workday'],
  ['.wd105.',            'workday'],
  ['wd3.myworkdayjobs',  'workday'],
  ['csod.com',           'cornerstone'],
  ['apply.jobadder.com', 'jobadder'],
  ['jobadder.com',       'jobadder'],
  ['teamtailor.com',     'teamtailor'],
  ['pageuppeople.com',   'pageup'],
  ['applr.io',           'pageup'],
  ['dayforcehcm.com',    'dayforce'],
  ['successfactors.com', 'successfactors'],
  ['taleo.net',          'taleo'],
  ['smartrecruiters.com','smartrecruiters'],
  ['randstad.com',       'randstad'],
  // Detected but handler not yet implemented — returns ats_not_implemented
  ['oraclecloud.com',    'oracle'],
  ['.fa.ocs.',           'oracle'],
  ['oracle.com/hcm',     'oracle'],
  ['nga.net.au',         'nga'],
  ['upplft.com',         'upplft'],
  ['iworkfor.',          'iworkfor'],
];

export function detectATS(url: string): ATSProvider | null {
  const u = url.toLowerCase();
  for (const [needle, provider] of ATS_PATTERNS) {
    if (u.includes(needle)) return provider;
  }
  return null;
}
