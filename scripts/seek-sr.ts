// Usage: npm run seek-sr
// Drains data/sr-queue.json — applies to SmartRecruiters jobs from a local headed browser.
// Run this from your machine (not CI) so SR's bot-detection is bypassed by a residential IP.

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { chromium } from '@playwright/test';
import { SeekPlatform } from '../lib/platforms/seek';
import { loadKB, saveKB } from '../lib/questions-kb';
import { logger } from '../lib/logger';
import * as tracker from '../lib/tracker';

const SR_QUEUE_PATH = path.resolve(__dirname, '../data/sr-queue.json');

interface SRQueueEntry {
  jobId: string;
  title: string;
  company: string;
  location: string;
  externalUrl: string;
  queuedAt: string;
  done: boolean;
}

async function main() {
  if (!fs.existsSync(SR_QUEUE_PATH)) {
    console.log('No SR queue found. Run the bot first to collect SR jobs.');
    return;
  }

  const queue: SRQueueEntry[] = JSON.parse(fs.readFileSync(SR_QUEUE_PATH, 'utf8'));
  const pending = queue.filter((e) => !e.done);

  if (pending.length === 0) {
    console.log('SR queue is empty — nothing to process.');
    return;
  }

  console.log(`SR queue: ${pending.length} pending job(s)`);

  const runId = new Date().toISOString();
  const kb = loadKB();
  const platform = new SeekPlatform();

  // Force headed mode so you can see and intervene if SR throws a CAPTCHA.
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await platform.authenticate(browser);
  const page = await context.newPage();

  const seekPlatform = platform as SeekPlatform & { loginAndVerify?: (p: typeof page) => Promise<boolean>; readBaseCoverLetter?: () => string };
  const baseCoverLetter = seekPlatform.readBaseCoverLetter?.() ?? '';

  if (seekPlatform.loginAndVerify) {
    const ok = await seekPlatform.loginAndVerify(page);
    if (!ok) {
      logger.error('seek-sr: session expired — re-run seek-login first', {});
      await browser.close();
      return;
    }
  }

  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of pending) {
    console.log(`\nProcessing: ${entry.title} @ ${entry.company}`);
    console.log(`  URL: ${entry.externalUrl}`);

    try {
      await page.goto(entry.externalUrl);
      await page.waitForTimeout(3_000);

      // Minimal details from queue entry (no SEEK job page to scrape).
      const details = {
        title:      entry.title,
        company:    entry.company,
        location:   entry.location,
        description:'',
        salaryText: '',
        workType:   '',
      };

      const result = await platform.applyToJob(page, context, details, {
        resumeVariant: 'pm',
        searchName: 'sr-queue',
        baseCoverLetter,
        kb,
      });

      const jobMeta = {
        jobId: entry.jobId,
        platform: 'seek-sr',
        title: entry.title,
        company: entry.company,
        location: entry.location,
        salaryText: '',
        workType: '',
        runId,
        atsProvider: result.atsProvider ?? 'smartrecruiters',
        externalUrl: entry.externalUrl,
      };

      if (result.success) {
        applied++;
        saveKB(kb);
        tracker.recordApplication({ ...jobMeta, resumeVariant: result.variant ?? 'pm' });
        console.log('  Applied!');
      } else if (result.skipReason) {
        skipped++;
        tracker.recordSkip({ ...jobMeta, skipReason: result.skipReason });
        console.log(`  Skipped: ${result.skipReason}`);
      } else {
        failed++;
        tracker.recordFailure({ ...jobMeta, failureReason: result.failureReason ?? 'unknown', requiresManualReview: result.requiresManualReview });
        console.log(`  Failed: ${result.failureReason}`);
      }

      // Mark done regardless of outcome — don't retry automatically.
      entry.done = true;
    } catch (err) {
      failed++;
      console.log(`  Error: ${(err as Error).message}`);
      entry.done = true;
    }

    // Save queue after each entry so progress is preserved if interrupted.
    fs.writeFileSync(SR_QUEUE_PATH, JSON.stringify(queue, null, 2));
    await page.waitForTimeout(5_000);
  }

  await browser.close();
  logger.info('seek-sr done', { applied, skipped, failed });
  console.log(`\nDone — applied: ${applied}, skipped: ${skipped}, failed: ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
