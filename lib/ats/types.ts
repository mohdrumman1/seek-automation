export interface ATSResult {
  status: 'applied' | 'skipped' | 'failed' | 'needs_manual_review';
  reason?: string;
}

export type ATSProvider =
  | 'workday'
  | 'cornerstone'
  | 'jobadder'
  | 'teamtailor'
  | 'pageup'
  | 'dayforce'
  | 'successfactors'
  | 'taleo'
  | 'smartrecruiters'
  | 'randstad'
  | 'oracle'
  | 'nga'
  | 'upplft'
  | 'iworkfor';
