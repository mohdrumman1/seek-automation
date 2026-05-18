import * as fs from 'fs';
import * as path from 'path';
import { Page } from '@playwright/test';
import { callOpenRouterVision } from './openrouter';

const ERROR_LOG_PATH = path.resolve(__dirname, '../data/error-log.json');
const SCREENSHOT_DIR = path.resolve(__dirname, '../screenshots/errors');

// When a fix is deployed, add an entry here so the AI analysis prompt knows
// what was already tried. If the error persists after the fix date, the AI
// will call it out explicitly rather than re-diagnosing the same root cause.
const KNOWN_FIXES: Record<string, { date: string; description: string }> = {
  session_expired: {
    date: '2026-05-18',
    description:
      'isSessionExpired() (lib/seek-session.ts) now uses URL-redirect detection: navigates to ' +
      'https://www.seek.com.au/my-activity (a protected page) and checks the final URL. ' +
      'If redirected to /oauth/login → expired; if still on /my-activity → valid session. ' +
      'This is immune to SEEK DOM changes that broke the previous selector-based approach. ' +
      'isLoggedIn() (lib/platforms/seek.ts) simplified to lightweight sign-in-button-only check. ' +
      'If this error still fires: (1) confirm cookies were copied raw (cat tmp/seek-cookies.b64) not decoded; ' +
      '(2) check if SEEK now redirects /my-activity somewhere other than /oauth/login — update the URL check; ' +
      '(3) the SEEK_SESSION_COOKIES secret may be genuinely expired — re-run npm run seek-login. ' +
      'HISTORY: prior version used DOM selector positive check (Promise.all + .some(Boolean)); ' +
      'before that, Promise.any bug always returned expired (fixed ea84466). ' +
      'DOM selector approach failed when SEEK changed their authenticated nav element attributes.',
  },
  braid_modal_blocks_click: {
    date: '2026-05-19',
    description:
      'After uploadTailoredResume(), SEEK leaves div#braid-modal-container open, intercepting all pointer events. ' +
      'Symptom: locator.click Timeout — element found, visible, stable, but "subtree intercepts pointer events". ' +
      'Fix: dismissBraidModal() in seek.ts waits for #braid-modal-container to clear (waitForFunction), ' +
      'falls back to Escape key + close button. Called in applyToJob() after resume upload and after page load. ' +
      'If this recurs: (1) check if SEEK added a new modal type that Escape doesn\'t close; ' +
      '(2) check #braid-modal-container children for a new close button selector; ' +
      '(3) consider adding a longer initial wait after setInputFiles().',
  },
  validation_errors_blocking_continue: {
    date: '2026-05-18',
    description:
      'Radio/checkbox groups handled in answerEmployerQuestions() via name-attribute grouping, label-first click, isChecked() confirmation. ' +
      'selectBestOption() fixed to strip commas before numeric parsing (so $120,000 parses as 120000 not 120). ' +
      'selectOption() filled check now trusts non-throw rather than inputValue() (SEEK options often have value="" causing false negatives). ' +
      'selectBestOption() normalizes \\xa0 non-breaking spaces before matching. ' +
      'If validation still blocks: (1) check review-queue.json for the exact label+options of the failing question; ' +
      '(2) add a KB entry with keywords matching that label and the correct option text as the answer; ' +
      '(3) if a radio/checkbox, verify label-click confirmation logs show "(unconfirmed)"; ' +
      '(4) date pickers and file uploads are not handled — those jobs will always fail.',
  },
};

export interface ErrorEntry {
  timestamp: string;
  error_type: string;
  job_title?: string;
  company?: string;
  url: string;
  page_title: string;
  screenshot: string;
  analysis: string;
}

export function loadErrorLog(): ErrorEntry[] {
  if (!fs.existsSync(ERROR_LOG_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(ERROR_LOG_PATH, 'utf-8')) as ErrorEntry[];
  } catch {
    return [];
  }
}

function saveErrorLog(log: ErrorEntry[]): void {
  fs.writeFileSync(ERROR_LOG_PATH, JSON.stringify(log, null, 2), 'utf-8');
}

// Returns the AI analyses from the last N occurrences of a given error type
export function getPastAnalyses(errorType: string, limit = 3): string[] {
  return loadErrorLog()
    .filter((e) => e.error_type === errorType)
    .slice(-limit)
    .map((e) => e.analysis)
    .filter(Boolean);
}

export async function captureAndAnalyze(
  page: Page,
  errorType: string,
  context?: { job_title?: string; company?: string }
): Promise<string> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotPath = path.join(SCREENSHOT_DIR, `${ts}_${errorType}.png`);

  let imageBase64 = '';
  try {
    const buffer = await page.screenshot({ path: screenshotPath, fullPage: false });
    imageBase64 = buffer.toString('base64');
    console.log(`  [Analyzer] Screenshot saved: ${path.basename(screenshotPath)}`);
  } catch {
    console.log(`  [Analyzer] Screenshot failed for ${errorType}`);
    return '';
  }

  const pageTitle = await page.title().catch(() => '');
  const url = page.url();

  const past = getPastAnalyses(errorType);
  const pastSection = past.length
    ? `\nPrevious analyses for this same error:\n${past.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
    : '';

  const knownFix = KNOWN_FIXES[errorType];
  const knownFixSection = knownFix
    ? `\nKNOWN FIX APPLIED (${knownFix.date}): ${knownFix.description}\nIf this error is still occurring after that date, the fix did not fully resolve it — describe what specifically is still failing.\n`
    : '';

  const prompt =
    `You are diagnosing a browser automation error on Seek.com.au.\n\n` +
    `Error type: ${errorType}\n` +
    `Page title: ${pageTitle}\n` +
    `URL: ${url}\n` +
    `Job: ${context?.job_title ?? 'unknown'} @ ${context?.company ?? 'unknown'}` +
    knownFixSection +
    pastSection +
    `\n\nLook at this screenshot and answer:\n` +
    `1. What is visible on screen right now?\n` +
    `2. What caused this error?\n` +
    `3. What specific CSS selector or action should the bot try next time to fix it?\n\n` +
    `Be concise. No more than 4 sentences.`;

  let analysis = '';
  try {
    analysis = await callOpenRouterVision(prompt, imageBase64);
    console.log(`  [Analyzer] ${errorType}: ${analysis.slice(0, 150)}${analysis.length > 150 ? '...' : ''}`);
  } catch (e) {
    console.log(`  [Analyzer] AI call failed: ${(e as Error).message}`);
    analysis = 'AI analysis unavailable';
  }

  const entry: ErrorEntry = {
    timestamp: new Date().toISOString(),
    error_type: errorType,
    job_title: context?.job_title,
    company: context?.company,
    url,
    page_title: pageTitle,
    screenshot: screenshotPath,
    analysis,
  };

  const log = loadErrorLog();
  log.push(entry);
  saveErrorLog(log);

  return analysis;
}
