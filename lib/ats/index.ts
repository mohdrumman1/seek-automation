import { Page } from '@playwright/test';
import { JobDetails, ApplyConfig } from '../platforms/types';
import { captureAndAnalyze } from '../error-analyzer';
import { logger } from '../logger';
import { ATSResult, ATSProvider } from './types';
import { detectATS } from './detect';
import { applyWorkday }         from './workday';
import { applyCornerstone }     from './cornerstone';
import { applyJobAdder }        from './jobadder';
import { applyTeamtailor }      from './teamtailor';
import { applyPageUp }          from './pageup';
import { applyDayforce }        from './dayforce';
import { applySuccessFactors }  from './successfactors';
import { applyTaleo }           from './taleo';
import { applyRandstad }        from './randstad';
import { applySmartRecruiters } from './smartrecruiters';

type Handler = (
  page: Page,
  details: JobDetails,
  config: ApplyConfig,
  resumePath: string | null,
  coverLetter: string,
) => Promise<ATSResult>;

const HANDLERS: Partial<Record<ATSProvider, Handler>> = {
  workday:        applyWorkday,
  cornerstone:    applyCornerstone,
  jobadder:       applyJobAdder,
  teamtailor:     applyTeamtailor,
  pageup:         applyPageUp,
  dayforce:       applyDayforce,
  successfactors: applySuccessFactors,
  taleo:          applyTaleo,
  randstad:       applyRandstad,
  smartrecruiters:applySmartRecruiters,
  // oracle, nga, upplft, iworkfor — detected but handler not yet implemented
};

export async function applyViaATS(
  page: Page,
  url: string,
  details: JobDetails,
  config: ApplyConfig,
  resumePath: string | null,
  coverLetter: string,
): Promise<{ result: ATSResult; provider: ATSProvider | null }> {
  const provider = detectATS(url);
  if (!provider) {
    // Log the full URL so we can identify new ATS patterns from CI output.
    logger.info('ats: unknown provider — skipping', { url: url.slice(0, 120), host: (() => { try { return new URL(url).hostname; } catch { return url; } })() });
    return { result: { status: 'skipped', reason: 'ats_unknown_provider' }, provider: null };
  }

  const handler = HANDLERS[provider];
  if (!handler) {
    logger.info('ats: provider detected but not implemented', { provider, url: url.slice(0, 80) });
    return { result: { status: 'skipped', reason: 'ats_not_implemented' }, provider };
  }

  logger.info('ats: routing', { provider, url: url.slice(0, 80) });
  try {
    const result = await handler(page, details, config, resumePath, coverLetter);
    logger.info('ats: handler done', { provider, status: result.status, reason: result.reason });
    return { result, provider };
  } catch (err) {
    logger.error('ats: handler threw', { provider }, err);
    await captureAndAnalyze(page, `ats_${provider}_error`, {
      job_title: details.title,
      company: details.company,
    });
    return { result: { status: 'failed', reason: `ats_${provider}_error` }, provider };
  }
}

export { detectATS } from './detect';
export type { ATSResult, ATSProvider } from './types';
