import { Page } from '@playwright/test';
import { JobDetails, ApplyConfig } from '../platforms/types';
import { ATSResult } from './types';

export async function applyTaleo(
  _page: Page,
  _details: JobDetails,
  _config: ApplyConfig,
  _resumePath: string | null,
  _coverLetter: string,
): Promise<ATSResult> {
  return { status: 'skipped', reason: 'ats_not_implemented' };
}
