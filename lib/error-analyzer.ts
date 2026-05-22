import * as fs from 'fs';
import * as path from 'path';
import { Page } from '@playwright/test';
import { callOpenRouterVision } from './openrouter';

const ERROR_LOG_PATH = path.resolve(__dirname, '../data/error-log.json');
const SCREENSHOT_DIR = path.resolve(__dirname, '../screenshots/errors');
const MAX_ERROR_LOG_ENTRIES = 500;

// When a fix is deployed, add an entry here so the AI analysis prompt knows
// what was already tried. If the error persists after the fix date, the AI
// will call it out explicitly rather than re-diagnosing the same root cause.
const KNOWN_FIXES: Record<string, { date: string; description: string }> = {
  session_expired: {
    date: '2026-05-19',
    description:
      'SEEK uses two auth layers: (1) a browsing session cookie valid for /my-activity and most profile pages; ' +
      '(2) an Auth0 token (login.seek.com) required for the apply flow. ' +
      'isSessionExpired() checking /my-activity only validates layer 1 — the bot can appear "logged in" ' +
      'while every apply attempt redirects to login.seek.com/login because the Auth0 token is expired. ' +
      'Fixes applied 2026-05-19: (a) apply.ts now aborts the entire run on the first session_expired failure ' +
      '(no more 27 wasted attempts across 9 searches); (b) isSignInPage in seek.ts now explicitly matches ' +
      'login.seek.com for immediate detection without waiting for element selectors. ' +
      'The underlying cause is always a genuinely expired SEEK_SESSION_COOKIES secret. ' +
      'To fix: re-run npm run seek-login locally and push the new SEEK_SESSION_COOKIES secret to GitHub. ' +
      'HISTORY: prior /my-activity check only looked for /oauth/login redirect pattern; SEEK later started ' +
      'using login.seek.com/login (Auth0) for apply-flow auth separately from browsing-session auth.',
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
  location_out_of_region: {
    date: '2026-05-22',
    description:
      'filterByLocation() in seek.ts blocked hybrid/on-site roles outside NSW/QLD. ' +
      'Rule: remote roles are always ok; hybrid/on-site require NSW, QLD, Sydney, Newcastle, Brisbane, etc. ' +
      'VIC/WA/SA/ACT/TAS/NT trigger the block. No clear state signal → allow (false-negative risk is low because ' +
      'SEEK search already filters workarrangement=2,3). ' +
      'If valid NSW/QLD hybrid roles are being blocked: check if SEEK changed the location format ' +
      'or if the location string is missing the state (add it to the allowed regex).',
  },
  ats_requires_account: {
    date: '2026-05-22',
    description:
      'ATS (usually Workday or PageUp classic) requires account creation before allowing apply. ' +
      'No guest/manual path offered. Bot returns ats_requires_account skip. ' +
      'If a tenant later offers "Apply Manually": check for [data-automation-id="applyManually"] ' +
      'in workday.ts or "Continue as guest" / "Apply without an account" in pageup.ts.',
  },
  ats_workday_account_failed: {
    date: '2026-05-22',
    description:
      'Workday sign-in and account-creation both failed. ' +
      'signInOrCreateAccount() tried: (1) [data-automation-id="signInLink"] with mohdrumman1@gmail.com + WORKDAY_PASSWORD; ' +
      '(2) [data-automation-id="createAccountLink"] with the same credentials. ' +
      'Possible causes: (a) WORKDAY_PASSWORD env var not set in GitHub secrets; ' +
      '(b) Workday tenant requires a different login method (SSO/Google only); ' +
      '(c) create-account form has unexpected required fields blocking submit. ' +
      'Check screenshot for the exact page state. Ensure WORKDAY_PASSWORD secret is set in GitHub.',
  },
  ats_workday_verify_email: {
    date: '2026-05-22',
    description:
      'Workday account created successfully but the tenant requires email verification before applying. ' +
      'Bot detected "verify your email" / "check your email" text and returned needs_manual_review. ' +
      'Fix: check mohdrumman1@gmail.com for the verification link and click it. ' +
      'On the next run the bot will sign in to the verified account and proceed automatically. ' +
      'If this keeps triggering for the same company: the account was already verified — ' +
      'check if Workday is sending verification again due to a session/cookie issue.',
  },
  ats_workday_wall_mid_apply: {
    date: '2026-05-22',
    description:
      'Workday account wall appeared mid-application (after sign-in or account creation succeeded). ' +
      'The bot was inside the wizard loop when the wall selector became visible again. ' +
      'Possible causes: (a) session cookie expired between wizard pages; ' +
      '(b) navigation triggered a re-login on a cross-tenant Workday page. ' +
      'Check the screenshot URL — if it contains "signIn" the session was dropped. ' +
      'No automatic recovery implemented; job is marked ats_requires_account.',
  },
  ats_workday_no_submit: {
    date: '2026-05-22',
    description:
      'Workday wizard loop exhausted without reaching a success page. ' +
      'Common causes: (1) required field missed (check screenshot for red validation errors); ' +
      '(2) CAPTCHA or bot-detection triggered; (3) "Next" button selector changed. ' +
      'Fix: (1) check which field is highlighted in error; add a CANDIDATE_PROFILE or KB entry; ' +
      '(2) if CAPTCHA, return needs_manual_review; (3) update [data-automation-id="bottom-navigation-next-button"].',
  },
  ats_jobadder_no_submit: {
    date: '2026-05-22',
    description:
      'JobAdder submit button not found or form not submitted successfully. ' +
      'Common causes: (1) Cloudflare Turnstile CAPTCHA on submit (bot should have returned ats_captcha); ' +
      '(2) required field missed — check screenshot for inline validation; ' +
      '(3) JobAdder updated their submit button selector. ' +
      'Fix: check screenshot, inspect DOM for submit button, update selector in jobadder.ts.',
  },
  ats_teamtailor_no_submit: {
    date: '2026-05-22',
    description:
      'Teamtailor submit button not found or application not confirmed. ' +
      'Common cause: GDPR consent checkbox not ticked (required to enable submit). ' +
      'Fix: verify the consent checkbox regex (/i agree|consent|privacy|gdpr/i) matches the label; ' +
      'add additional label patterns if needed. Also check for new custom-question types.',
  },
  auto_skip_still_blocked: {
    date: '2026-05-22',
    description:
      'Root cause: multi-select checkbox groups (skills/tools/certs like "front-end libraries", ' +
      '"data visualisation tools", "Microsoft Azure certifications") were completely unhandled — ' +
      'answerEmployerQuestions() had no input[type=checkbox] handling. ' +
      'Fix 2026-05-22: added checkbox group block after radio handling in answerEmployerQuestions(). ' +
      'Groups detected by name attribute (count>=2 guard to skip consent checkboxes). ' +
      'AI answer via aiAnswerCheckboxes() returns comma-separated list of applicable options. ' +
      'fillFieldByLabel() and handleUnansweredQuestions() also updated with checkbox branch. ' +
      'If still blocked: (1) check if the question name attribute exists on the checkboxes; ' +
      '(2) verify optionLabels are being extracted (label[for=id] chain); ' +
      '(3) check if the AI is returning any selections in the log.',
  },
  unanswered_questions: {
    date: '2026-05-22',
    description:
      'Two root causes: ' +
      '(1) Salary/rate number fields: answer.match(/\\d+/) truncated "$120,000" to "120" (stopped at comma). ' +
      'Fix 2026-05-22: strip $, comma, whitespace before matching — "$120,000" now fills "120000". ' +
      '(2) Daily/contract rate: CANDIDATE_PROFILE had no day rate — AI invented "$60/day". ' +
      'Fix 2026-05-22: added "Expected daily rate: $700 AUD per day (range $650 - $750)" to profile. ' +
      'If recurs: check what label the failing field uses; add a KB entry with exact keywords from that label.',
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

export function trimErrorLog(log: ErrorEntry[], max = MAX_ERROR_LOG_ENTRIES): ErrorEntry[] {
  return log.length > max ? log.slice(log.length - max) : log;
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
  fs.writeFileSync(ERROR_LOG_PATH, JSON.stringify(trimErrorLog(log), null, 2), 'utf-8');
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
