import * as fs from 'fs';
import * as path from 'path';
import { Page } from '@playwright/test';
import { JobDetails, ApplyConfig } from '../platforms/types';
import { ATSResult } from './types';
import { logger } from '../logger';

const SR_QUEUE_PATH = path.resolve(__dirname, '../../data/sr-queue.json');

interface SRQueueEntry {
  jobId: string;
  title: string;
  company: string;
  location: string;
  externalUrl: string;
  queuedAt: string;
  done: boolean;
}

// SmartRecruiters blocks headless Chromium on datacenter IPs.
// Instead of attempting and failing, queue the job for local processing
// via `npm run seek-sr` (headed browser from residential IP).
export async function applySmartRecruiters(
  page: Page,
  details: JobDetails,
  _config: ApplyConfig,
  _resumePath: string | null,
  _coverLetter: string,
): Promise<ATSResult> {
  const jobId = page.url().match(/\d{5,}/)?.[0] ?? Date.now().toString();
  const entry: SRQueueEntry = {
    jobId,
    title:       details.title,
    company:     details.company,
    location:    details.location,
    externalUrl: page.url(),
    queuedAt:    new Date().toISOString(),
    done:        false,
  };

  try {
    const queue: SRQueueEntry[] = fs.existsSync(SR_QUEUE_PATH)
      ? (JSON.parse(fs.readFileSync(SR_QUEUE_PATH, 'utf8')) as SRQueueEntry[])
      : [];

    if (!queue.some((q) => q.jobId === entry.jobId)) {
      queue.push(entry);
      fs.writeFileSync(SR_QUEUE_PATH, JSON.stringify(queue, null, 2));
      logger.info('ats: SR job queued for local run', {
        title: details.title,
        company: details.company,
        jobId,
      });
    }
  } catch (err) {
    logger.warn('ats: could not write SR queue', { error: String(err) });
  }

  return { status: 'skipped', reason: 'ats_queued_sr' };
}
