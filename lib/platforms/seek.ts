// SEEK platform implementation of the JobPlatform interface.
// All SEEK-specific selectors, login logic, and form-filling live here.
// The generic orchestration loop lives in scripts/apply.ts.

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Browser, BrowserContext, Page, Locator } from '@playwright/test';
import { JobPlatform, JobDetails, SearchConfig, ApplyResult, ApplyConfig } from './types';
import { selectResume, resolveResumeVariant, ResumeVariant } from '../resume-selector';
import { getOrCreateSession, saveSession, isSessionExpired } from '../seek-session';
import { captureAndAnalyze, getPastAnalyses } from '../error-analyzer';
import { findKBAnswer, aiAnswerQuestion, selectBestOption } from '../questions-kb';
import { tailorCoverLetter, callOpenRouter } from '../openrouter';
import { tailorResume, TailoredContent } from '../resume-tailor';
import { generateTailoredDocx } from '../resume-generator';
import { cleanTailoredResumes, uploadTailoredResume } from '../resume-manager';
import { logger } from '../logger';
import { readBaseCoverLetter } from '../cover-letter';

const SEEK_EMAIL = process.env.SEEK_EMAIL ?? 'mohdrumman1@gmail.com';
const REVIEW_QUEUE_PATH = path.resolve(__dirname, '../../data/review-queue.json');

const CANDIDATE_PROFILE = `
Name: Rumman Riyaz
Location: Newcastle/Sydney/Brisbane, NSW and QLD (open to remote and hybrid)
Work rights: Family/partner visa with no restrictions
Notice period: 2 weeks
Expected salary: $120,000 - $150,000 AUD + superannuation
Years of project management experience: 5 years
Years of software engineering experience: 4 years
Education: Bachelor of Computer Systems Engineering, University of Newcastle
Certifications: PMP (Jan 2026), AWS Certified Cloud Practitioner
Current role: Technical Project Manager & Software Engineer at Service Stream Group
Key achievements:
- Led $50M SCADA infrastructure upgrade for Queensland Urban Utilities across 200+ sites
- Automated contractor payment reconciliation saving $10K/week
- Built AI image deduplication feature saving ~$100K/month in false payments
Skills: Agile/Scrum, Waterfall, hybrid delivery, stakeholder management, risk management,
  budget/CAPEX/OPEX tracking, vendor management, Python, C#, React, AWS, MS Project, Jira
Tools: MS Project, Jira, Confluence, ServiceNow, Azure DevOps, GitHub, AWS console
ERP/systems experience: ServiceNow, Azure DevOps; limited SAP exposure
Willing to relocate: Open to hybrid/remote within NSW and QLD only
`;

const CLEARANCE_RE =
  /\b(NV1|NV2|NV-1|NV-2|AGSVA|baseline clearance|negative vetting|security clearance required|must hold.{0,20}clearance|clearance required|active.{0,10}clearance|top secret)\b/i;

const SEEK_SEARCHES: SearchConfig[] = [
  {
    name: 'Project Manager (ICT)',
    url: 'https://www.seek.com.au/project-manager-jobs-in-information-communication-technology?daterange=3&pos=1&salaryrange=120000-&salarytype=annual&sitekey=AU-Main&workarrangement=2%2C3&worktype=242%2C244',
    resumeVariant: 'pm',
  },
  {
    name: 'Technical Project Manager',
    url: 'https://www.seek.com.au/technical-project-manager-jobs?daterange=3&salaryrange=120000-&salarytype=annual&workarrangement=2%2C3&worktype=242%2C244',
    resumeVariant: 'pm',
  },
  {
    name: 'Delivery Manager / Lead',
    url: 'https://www.seek.com.au/delivery-manager-jobs?daterange=3&salaryrange=120000-&salarytype=annual&workarrangement=2%2C3&worktype=242%2C244',
    resumeVariant: 'pm',
  },
  {
    name: 'Software Engineer (ICT)',
    url: 'https://www.seek.com.au/software-engineer-jobs-in-information-communication-technology?daterange=3&salaryrange=120000-&salarytype=annual&workarrangement=2%2C3&worktype=242%2C244',
    resumeVariant: 'se',
  },
  {
    name: 'Full Stack Developer',
    url: 'https://www.seek.com.au/full-stack-developer-jobs?daterange=3&salaryrange=120000-&salarytype=annual&workarrangement=2%2C3&worktype=242%2C244',
    resumeVariant: 'se',
  },
  {
    name: 'Backend Developer',
    url: 'https://www.seek.com.au/backend-developer-jobs?daterange=3&salaryrange=120000-&salarytype=annual&workarrangement=2%2C3&worktype=242%2C244',
    resumeVariant: 'se',
  },
  {
    name: 'Cloud Engineer',
    url: 'https://www.seek.com.au/cloud-engineer-jobs?daterange=3&salaryrange=120000-&salarytype=annual&workarrangement=2%2C3&worktype=242%2C244',
    resumeVariant: 'se',
  },
  {
    name: 'AI Engineer',
    url: 'https://www.seek.com.au/ai-engineer-jobs?daterange=3&salaryrange=120000-&salarytype=annual&workarrangement=2%2C3&worktype=242%2C244',
    resumeVariant: 'se',
  },
  {
    name: 'AI Consultant',
    url: 'https://www.seek.com.au/jobs?keywords=AI+consultant&classification=6281&daterange=3&salaryrange=120000-&salarytype=annual&workarrangement=2%2C3&worktype=242%2C244',
    resumeVariant: 'se',
  },
];

// ── UTILITIES ─────────────────────────────────────────────────────────────────

function askUser(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => rl.question(prompt, (ans) => { rl.close(); resolve(ans); }));
}

function saveToReviewQueue(url: string, unanswered: UnansweredQuestion[], ctx: { job_title?: string; company?: string }): void {
  let queue: unknown[] = [];
  if (fs.existsSync(REVIEW_QUEUE_PATH)) {
    try { queue = JSON.parse(fs.readFileSync(REVIEW_QUEUE_PATH, 'utf-8')) as unknown[]; } catch {}
  }
  queue.push({
    timestamp: new Date().toISOString(),
    job_title: ctx.job_title,
    company: ctx.company,
    url,
    unanswered,
    resolved: false,
  });
  fs.writeFileSync(REVIEW_QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf-8');
  console.log(`  [ReviewQueue] Saved ${unanswered.length} unanswered question(s) to data/review-queue.json`);
}

interface UnansweredQuestion {
  label: string;
  type: 'select' | 'textarea' | 'input';
  options?: string[];
}

// ── QUESTION LABEL ────────────────────────────────────────────────────────────

async function getQuestionLabel(page: Page, locator: Locator): Promise<string> {
  const ariaLabel = await locator.getAttribute('aria-label').catch(() => null);
  if (ariaLabel?.trim()) return ariaLabel.trim();

  const labelledBy = await locator.getAttribute('aria-labelledby').catch(() => null);
  if (labelledBy) {
    const text = await page.locator(`#${labelledBy}`).textContent().catch(() => '');
    if (text?.trim()) return text.trim();
  }
  const id = await locator.getAttribute('id').catch(() => null);
  if (id) {
    const text = await page.locator(`label[for="${id}"]`).textContent().catch(() => '');
    if (text?.trim()) return text.trim();
  }
  const text = await locator
    .evaluate((el: Element) => {
      let node = el.parentElement;
      while (node) {
        const label = node.querySelector('label, legend');
        if (label) {
          const t = label.textContent?.trim() ?? '';
          if (t && t.length < 400) return t;
        }
        node = node.parentElement;
      }
      return '';
    })
    .catch(() => '');
  return text ?? '';
}

// ── MODAL DISMISSAL ───────────────────────────────────────────────────────────

// SEEK uses a div#braid-modal-container that intercepts pointer events while any
// dialog is open. After a file upload it can remain open, blocking all clicks.
// This function waits for the container to clear, falling back to Escape + close button.
async function dismissBraidModal(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const c = document.getElementById('braid-modal-container');
        return !c || !c.firstElementChild;
      },
      { timeout: 3_000 },
    );
    return;
  } catch {
    // Still present — try to dismiss
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const closeBtn = page
    .locator('#braid-modal-container')
    .locator(
      'button[aria-label*="close" i], button:has-text("Close"), button:has-text("Done"), button:has-text("OK"), button:has-text("Got it"), button:has-text("Confirm")',
    )
    .first();
  if (await closeBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await closeBtn.click().catch(() => {});
    await page.waitForTimeout(500);
  }
}

// ── FIELD FILL ────────────────────────────────────────────────────────────────

async function fillFieldByLabel(
  page: Page,
  q: UnansweredQuestion,
  answer: string
): Promise<boolean> {
  const normalize = (s: string) => s.toLowerCase().trim();
  const labelMatch = (lbl: string) =>
    normalize(lbl).includes(normalize(q.label)) || normalize(q.label).includes(normalize(lbl));

  if (q.type === 'select') {
    for (const sel of await page.locator('select').all()) {
      const lbl = await getQuestionLabel(page, sel).catch(() => '');
      if (!labelMatch(lbl)) continue;
      const options = await sel.locator('option').allTextContents();
      const best = selectBestOption(options, answer);
      await sel.selectOption({ label: best }).catch(() => {});
      return true;
    }
  }
  if (q.type === 'textarea') {
    for (const ta of await page.locator('textarea').all()) {
      const lbl = await getQuestionLabel(page, ta).catch(() => '');
      if (!labelMatch(lbl)) continue;
      await ta.fill(answer).catch(() => {});
      return true;
    }
  }
  if (q.type === 'input') {
    for (const inp of await page.locator('input[type="text"], input[type="number"]').all()) {
      const lbl = await getQuestionLabel(page, inp).catch(() => '');
      if (!labelMatch(lbl)) continue;
      await inp.fill(answer).catch(() => {});
      return true;
    }
  }
  return false;
}

// ── UNANSWERED QUESTIONS HANDLER ──────────────────────────────────────────────

async function handleUnansweredQuestions(
  page: Page,
  unanswered: UnansweredQuestion[],
  kb: ApplyConfig['kb'],
  ctx: { job_title?: string; company?: string }
): Promise<void> {
  if (unanswered.length === 0) return;

  if (!process.stdin.isTTY) {
    console.log(`  ${unanswered.length} unanswered question(s) - attempting autonomous AI answers`);
    for (const q of unanswered) {
      const optionsList = q.options?.filter((o) => o.trim()).join(' | ') ?? '';
      const prompt =
        `You are completing a job application form for this candidate:\n${CANDIDATE_PROFILE}\n\n` +
        `Question: "${q.label}"\n` +
        (optionsList ? `Available options: ${optionsList}\n` : '') +
        `Return ONLY the exact answer text (matching one of the options if provided). ` +
        `For Yes/No questions always return "Yes" or "No". No explanation.`;
      const answer = await callOpenRouter(prompt).catch(() => '');
      if (answer.trim()) {
        const keywords = q.label.toLowerCase().split(/\W+/).filter((w) => w.length > 3).slice(0, 6);
        kb.push({ keywords, answer: answer.trim() });
        const filled = await fillFieldByLabel(page, q, answer.trim());
        console.log(`  [Auto] "${q.label.slice(0, 50)}" → "${answer.trim().slice(0, 40)}"${filled ? '' : ' (fill failed)'}`);
      }
    }
    saveToReviewQueue(page.url(), unanswered, ctx);
    return;
  }

  console.log(`\n  --- BOT NEEDS YOUR HELP (${unanswered.length} unanswered question(s)) ---`);
  for (const q of unanswered) {
    console.log(`  Question: "${q.label}"`);
    if (q.options && q.options.length > 0) console.log(`  Options:  ${q.options.filter((o) => o.trim()).join(' | ')}`);
    const answer = await askUser('  Your answer (Enter to skip): ');
    if (!answer.trim()) { console.log('  Skipped.\n'); continue; }
    const keywords = q.label.toLowerCase().split(/\W+/).filter((w) => w.length > 3).slice(0, 6);
    kb.push({ keywords, answer: answer.trim() });
    console.log('  Saved to knowledge base.');
    const filled = await fillFieldByLabel(page, q, answer.trim());
    if (!filled) console.log(`  Could not locate field on page.`);
    console.log();
  }
}

// ── ANSWER EMPLOYER QUESTIONS ─────────────────────────────────────────────────

async function answerEmployerQuestions(
  page: Page,
  kb: ApplyConfig['kb']
): Promise<UnansweredQuestion[]> {
  const unanswered: UnansweredQuestion[] = [];

  for (const sel of await page.locator('select').all()) {
    if (!(await sel.isVisible().catch(() => false))) continue;
    const name = (await sel.getAttribute('name') ?? '').toLowerCase();
    if (name.includes('resume')) continue;
    const currentVal = await sel.inputValue().catch(() => '');
    if (currentVal) continue;
    const label = await getQuestionLabel(page, sel);
    if (!label) continue;
    const options = await sel.locator('option').allTextContents();
    const answer =
      findKBAnswer(label, kb) ?? (await aiAnswerQuestion(label, options, kb, CANDIDATE_PROFILE));
    if (answer) {
      const best = selectBestOption(options, answer);
      let filled = false;
      try {
        // selectOption throws if no matching option is found — that's our filled signal.
        // inputValue() is unreliable when option value attributes are empty strings.
        await sel.selectOption({ label: best });
        filled = true;
      } catch {}
      if (!filled) unanswered.push({ label, type: 'select', options: options.filter((o) => o.trim()) });
    } else {
      unanswered.push({ label, type: 'select', options: options.filter((o) => o.trim()) });
    }
  }

  for (const ta of await page.locator('textarea').all()) {
    if (!(await ta.isVisible().catch(() => false))) continue;
    if (await ta.inputValue().catch(() => '')) continue;
    const label = await getQuestionLabel(page, ta);
    if (!label) continue;
    const answer = findKBAnswer(label, kb) ?? (await aiAnswerQuestion(label, null, kb, CANDIDATE_PROFILE));
    if (answer) await ta.fill(answer).catch(() => {});
    else unanswered.push({ label, type: 'textarea' });
  }

  for (const inp of await page.locator('input[type="text"], input[type="number"]').all()) {
    if (!(await inp.isVisible().catch(() => false))) continue;
    if (await inp.inputValue().catch(() => '')) continue;
    const label = await getQuestionLabel(page, inp);
    if (!label) continue;
    const answer = findKBAnswer(label, kb) ?? (await aiAnswerQuestion(label, null, kb, CANDIDATE_PROFILE));
    if (answer) {
      const type = await inp.getAttribute('type');
      if (type === 'number') { const nums = answer.match(/\d+/); await inp.fill(nums ? nums[0] : answer).catch(() => {}); }
      else await inp.fill(answer).catch(() => {});
    } else {
      unanswered.push({ label, type: 'input' });
    }
  }

  const radioNames = new Set<string>();
  for (const radio of await page.locator('input[type="radio"]').all()) {
    if (!(await radio.isVisible().catch(() => false))) continue;
    const name = await radio.getAttribute('name').catch(() => null);
    if (name) radioNames.add(name);
  }
  for (const name of radioNames) {
    const radios = page.locator(`input[type="radio"][name="${name}"]`);
    const count = await radios.count();
    if (count === 0) continue;
    const anyChecked = await Promise.all(Array.from({ length: count }, (_, i) => radios.nth(i).isChecked().catch(() => false)));
    if (anyChecked.some(Boolean)) continue;
    const label = await getQuestionLabel(page, radios.first());
    if (!label) continue;
    const optionLabels: string[] = [];
    for (let i = 0; i < count; i++) {
      const radio = radios.nth(i);
      const id = await radio.getAttribute('id').catch(() => null);
      let optLabel = '';
      if (id) optLabel = (await page.locator(`label[for="${id}"]`).textContent().catch(() => '')) ?? '';
      if (!optLabel.trim()) optLabel = (await radio.getAttribute('aria-label').catch(() => null)) ?? '';
      if (!optLabel.trim()) optLabel = (await radio.getAttribute('value').catch(() => '')) ?? '';
      optionLabels.push(optLabel.trim());
    }
    const answer = findKBAnswer(label, kb) ?? (await aiAnswerQuestion(label, optionLabels.filter(Boolean), kb, CANDIDATE_PROFILE));
    if (!answer) { unanswered.push({ label, type: 'select', options: optionLabels.filter(Boolean) }); continue; }
    const best = selectBestOption(optionLabels.filter(Boolean), answer);
    let clicked = false;
    for (let i = 0; i < count; i++) {
      if (optionLabels[i].toLowerCase() !== best.toLowerCase()) continue;
      const radio = radios.nth(i);
      const id = await radio.getAttribute('id').catch(() => null);
      if (id) {
        const lbl = page.locator(`label[for="${id}"]`);
        if (await lbl.isVisible().catch(() => false)) { await lbl.click().catch(() => {}); clicked = true; break; }
      }
      await radio.click().catch(() => {});
      clicked = true;
      break;
    }
    if (!clicked) unanswered.push({ label, type: 'select', options: optionLabels.filter(Boolean) });
  }

  return unanswered;
}

// ── COVER LETTER FILL ─────────────────────────────────────────────────────────

async function fillCoverLetter(page: Page, text: string, ctx: { job_title?: string; company?: string }): Promise<boolean> {
  const selectors = [
    'textarea[data-automation="coverLetter"]',
    'textarea[data-automation*="cover"]',
    'textarea[name*="over"]',
    'textarea[id*="over"]',
    'textarea',
  ];
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      await el.fill(text);
      const actual = await el.inputValue().catch(() => '');
      if (actual.length > 20) {
        console.log(`  Cover letter filled (${actual.length} chars) via ${sel}`);
        return true;
      }
    }
  }
  const past = getPastAnalyses('cover_letter_fill_failed');
  const richTextLikely = past.length === 0 || past.some((a) => /contenteditable|rich.?text|quill|tiptap|draft|editor/i.test(a));
  if (richTextLikely) {
    const richText = page.locator('[contenteditable="true"]:not([aria-hidden="true"])').first();
    if (await richText.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await richText.click();
      await richText.evaluate((el) => { (el as HTMLElement).innerHTML = ''; });
      await page.keyboard.type(text, { delay: 5 });
      const content = (await richText.textContent()) ?? '';
      if (content.length > 20) {
        console.log(`  Cover letter filled via rich text editor (${content.length} chars)`);
        return true;
      }
    }
  }
  console.log('  Cover letter fill FAILED');
  await captureAndAnalyze(page, 'cover_letter_fill_failed', ctx);
  return false;
}

// ── CLICK CONTINUE ────────────────────────────────────────────────────────────

async function clickContinue(page: Page, ctx: { job_title?: string; company?: string }): Promise<boolean> {
  const skipWords = [
    'back', 'cancel', 'close', 'exit', 'save draft', 'sign in', 'log in',
    'review and submit', 'answer employer', 'update seek', 'choose document',
    'with apple', 'with google', 'sign in with', 'continue with apple',
    'sign in with iphone', 'use passkey',
    'submit',
  ];
  const continueBtn = page.locator('button').filter({ hasText: /^(continue|next|proceed)$/i });
  if (await continueBtn.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
    await continueBtn.first().scrollIntoViewIfNeeded();
    await continueBtn.first().click();
    return true;
  }
  const allBtns = page.locator('button');
  const count = await allBtns.count();
  for (let i = count - 1; i >= 0; i--) {
    const btn = allBtns.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    if (!(await btn.isEnabled().catch(() => false))) continue;
    const text = (await btn.textContent() ?? '').toLowerCase().trim();
    if (!text || skipWords.some((w) => text.includes(w))) continue;
    console.log(`  clickContinue fallback: clicking '${text}'`);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    return true;
  }
  const allTexts: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = (await allBtns.nth(i).textContent() ?? '').trim();
    if (t) allTexts.push(t);
  }
  console.log(`  clickContinue FAILED. Buttons on page: ${allTexts.join(', ')}`);
  await captureAndAnalyze(page, 'continue_button_not_found', ctx);
  return false;
}

// ── VALIDATION ERRORS ─────────────────────────────────────────────────────────

async function getValidationErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  const sels = ["[role='alert']", "[aria-live='polite']", "[data-automation*='error']", '.error-message'];
  for (const sel of sels) {
    for (const el of await page.locator(sel).all()) {
      if (await el.isVisible().catch(() => false)) {
        const t = (await el.textContent() ?? '').trim();
        if (t) errors.push(t);
      }
    }
  }
  return errors;
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────

async function isLoggedIn(page: Page): Promise<boolean> {
  // isSessionExpired() uses the reliable URL-redirect check on /my-activity.
  // This helper does a lighter inline check on whatever page is already loaded.
  const signInVisible = await page
    .locator('a[href*="oauth/login"], a[data-automation="sign-in"], a:has-text("Sign in"), button:has-text("Sign in")')
    .first().isVisible({ timeout: 2_000 }).catch(() => false);
  return !signInVisible;
}

async function login(page: Page): Promise<void> {
  await page.goto('https://www.seek.com.au', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);
  if (await isLoggedIn(page)) { console.log('Already logged in via saved session.'); return; }
  // In CI, we can't interactively re-authenticate — flag clearly and let loginAndVerify abort.
  if (!process.stdin.isTTY) {
    logger.warn('seek session: cookies loaded but SEEK reports not logged in — session likely expired', {
      hint: 'Re-run `npm run seek-login` locally, update SEEK_SESSION_COOKIES secret.',
    });
    return;
  }

  console.log('\nNot logged in. Opening Seek login page...');
  await page.goto('https://www.seek.com.au/oauth/login?returnUrl=https%3A%2F%2Fwww.seek.com.au%2F', { waitUntil: 'domcontentloaded' });
  const emailField = page.locator('#email');
  if (await emailField.isVisible({ timeout: 4_000 }).catch(() => false)) {
    await emailField.fill(SEEK_EMAIL);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(2_000);
  }
  const otpField = page.locator('input[autocomplete="one-time-code"], input[name="code"], input[type="number"]');
  if (await otpField.isVisible({ timeout: 5_000 }).catch(() => false)) {
    console.log('\nSeek sent a verification code to your email.');
    const code = await askUser('Enter the code here and press Enter: ');
    await otpField.fill(code.trim());
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3_000);
  } else {
    console.log('\nPlease log in to Seek in the browser window. Waiting 30 seconds...\n');
    for (let i = 30; i > 0; i -= 5) {
      await page.waitForTimeout(5_000);
      if (await isLoggedIn(page)) { console.log('Login detected.'); return; }
      if (i > 5) console.log(`  ${i - 5} seconds remaining...`);
    }
  }
  if (await isLoggedIn(page)) console.log('Logged in successfully.');
  else console.log('Warning: could not confirm login. Proceeding anyway.');
}

// ── SEEK PLATFORM ─────────────────────────────────────────────────────────────

export class SeekPlatform implements JobPlatform {
  readonly name = 'seek';

  get searches(): SearchConfig[] {
    return SEEK_SEARCHES;
  }

  async authenticate(browser: Browser): Promise<BrowserContext> {
    return getOrCreateSession(browser);
  }

  async persistSession(context: BrowserContext): Promise<void> {
    return saveSession(context);
  }

  async isSessionExpired(page: Page): Promise<boolean> {
    return isSessionExpired(page);
  }

  async getJobLinks(page: Page): Promise<string[]> {
    try {
      await page.waitForSelector('[data-automation="normalJob"], [data-automation="premiumJob"]', { timeout: 15_000 });
    } catch {
      console.log('  No job cards found.');
      return [];
    }
    const links = await page.$$eval(
      '[data-automation="normalJob"] a[href*="/job/"], [data-automation="premiumJob"] a[href*="/job/"], ' +
      '[data-automation="normalJob"] [data-automation="job-list-view-job-link"], ' +
      '[data-automation="premiumJob"] [data-automation="job-list-view-job-link"]',
      (els) => {
        const hrefs = (els as HTMLAnchorElement[]).map((a) => a.href).filter((h) => h.includes('/job/')).map((h) => h.split('?')[0]);
        return [...new Set(hrefs)];
      }
    );
    return links;
  }

  async getJobDetails(page: Page): Promise<JobDetails> {
    const title = (await page.locator('[data-automation="job-detail-title"], h1').first().textContent().catch(() => 'Unknown Role')) ?? 'Unknown Role';
    const company = (await page.locator('[data-automation="advertiser-name"], [data-automation="job-company-name"]').first().textContent().catch(() => 'Unknown Company')) ?? 'Unknown Company';
    const description = (await page.locator('[data-automation="jobAdDetails"]').textContent().catch(() => '')) ?? '';
    const location = (await page.locator('[data-automation="job-detail-location"], [data-automation="location"]').first().textContent().catch(() => '')) ?? '';
    const salaryText = (await page.locator('[data-automation="job-detail-salary"], [data-automation="salary"]').first().textContent().catch(() => '')) ?? '';
    const workType = (await page.locator('[data-automation="job-detail-work-type"], [data-automation="work-type"]').first().textContent().catch(() => '')) ?? '';
    return {
      title: title.trim(),
      company: company.trim(),
      description,
      location: location.trim(),
      salaryText: salaryText.trim(),
      workType: workType.trim(),
    };
  }

  async applyToJob(
    page: Page,
    context: BrowserContext,
    details: JobDetails,
    config: ApplyConfig,
  ): Promise<ApplyResult> {
    const ctx = { job_title: details.title, company: details.company };

    // External apply check
    const isExt =
      (await page.locator('[data-automation="job-detail-apply-external"]').count()) > 0 ||
      await (async () => {
        const btns = page.locator('[data-automation*="apply"]');
        const n = await btns.count();
        for (let i = 0; i < n; i++) {
          const text = (await btns.nth(i).textContent() ?? '').toLowerCase();
          if (text.includes('advertiser') || text.includes('company website') || text.includes('external')) return true;
        }
        return false;
      })();
    if (isExt) {
      console.log('  Skipping - external application (advertiser\'s site)');
      return { success: false, skipReason: 'external_apply' };
    }

    console.log(`  Applying: ${details.title} @ ${details.company}`);

    if (CLEARANCE_RE.test(details.description)) {
      console.log('  Skipping - job requires security clearance');
      logger.info('skip: security clearance required', { title: details.title, company: details.company });
      return { success: false, skipReason: 'security_clearance_required' };
    }

    const applyBtn = page.locator(
      '[data-automation="job-detail-apply"], [data-automation="job-detail-apply-button"], a[data-automation*="apply"]'
    ).first();
    if (!(await applyBtn.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false))) {
      console.log('  Apply button not found - skipping');
      await captureAndAnalyze(page, 'apply_button_not_found', ctx);
      return { success: false, skipReason: 'apply_button_not_found' };
    }

    let newPage: Page | null = null;
    const [maybeNewPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 3_000 }).catch(() => null),
      applyBtn.click(),
    ]);
    newPage = maybeNewPage;

    const applyPage = newPage ?? page;
    await applyPage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    const isSeekUrl = applyPage.url().includes('seek.com.au') || applyPage.url().includes('au.seek.com');
    if (!isSeekUrl) {
      console.log(`  Skipping - Apply redirected to external: ${applyPage.url().slice(0, 60)}`);
      await captureAndAnalyze(applyPage, 'redirected_to_external_ats', ctx);
      if (newPage) await newPage.close().catch(() => {});
      return { success: false, skipReason: 'redirected_to_external_ats' };
    }

    // Bail immediately if SEEK forced us to a sign-in page (expired session).
    // Without this, the bot wastes ~60s per job trying to fill a login form.
    const applyUrl = applyPage.url();
    const isSignInPage =
      applyUrl.includes('/oauth/login') ||
      applyUrl.includes('appleid.apple.com') ||
      applyUrl.includes('accounts.google.com') ||
      (await applyPage.locator('[data-automation="sign in"], a:has-text("Sign in to apply"), h1:has-text("Sign in")').first().isVisible({ timeout: 3_000 }).catch(() => false));
    if (isSignInPage) {
      logger.error('apply redirected to sign-in — session expired', {
        url: applyUrl,
        hint: 'Re-run `npm run seek-login` locally and update SEEK_SESSION_COOKIES secret.',
      });
      if (newPage) await newPage.close().catch(() => {});
      return { success: false, failureReason: 'session_expired' };
    }

    await dismissBraidModal(applyPage);
    const tailoredCoverLetter = await tailorCoverLetter(config.baseCoverLetter, details.title, details.company, details.description);
    await applyPage.waitForTimeout(2_000);

    const resolvedVariant = resolveResumeVariant(details.title, config.searchName);
    const finalVariant: ResumeVariant = resolvedVariant ?? config.resumeVariant;

    // Resume tailoring — generate a per-job DOCX and upload it to the apply form.
    // Falls back to selecting from the SEEK dropdown if tailoring is disabled or fails.
    const tailoringEnabled = process.env.RESUME_TAILORING_ENABLED === 'true';
    let resumeUploaded = false;
    if (tailoringEnabled) {
      const jobId = applyUrl.match(/\/job\/(\d+)/)?.[1] ?? Date.now().toString();
      const tailoredResume = await tailorResume(
        finalVariant,
        details.title,
        details.company,
        details.description,
        applyUrl,
      );
      if (tailoredResume) {
        const docxPath = await generateTailoredDocx(tailoredResume, jobId).catch((err) => {
          logger.warn('resume-generator: DOCX generation failed', { error: String(err) });
          return null;
        });
        if (docxPath) {
          resumeUploaded = await uploadTailoredResume(applyPage, docxPath);
          if (!resumeUploaded) {
            logger.warn('resume-manager: upload failed — falling back to dropdown selection');
          }
        }
      }
    }

    if (!resumeUploaded) {
      await selectResume(applyPage, finalVariant);
    }
    await applyPage.waitForTimeout(500);
    await dismissBraidModal(applyPage);

    const clChangeRadio = applyPage.locator('input[name="coverLetter-method"][value="change"]');
    if (await clChangeRadio.isVisible().catch(() => false)) {
      await clChangeRadio.click();
      await applyPage.waitForTimeout(500);
      console.log('  Cover letter mode: enter text');
    }

    await fillCoverLetter(applyPage, tailoredCoverLetter, ctx);

    const errsBefore = await getValidationErrors(applyPage);
    if (errsBefore.length) console.log(`  Form errors before Continue: ${errsBefore.slice(0, 3)}`);
    await clickContinue(applyPage, ctx);
    const errsAfter = await getValidationErrors(applyPage);
    if (errsAfter.length) console.log(`  Validation errors after Continue (page 1 blocked): ${errsAfter.slice(0, 3)}`);

    let earlyFailureReason: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      await applyPage.waitForTimeout(2_000);

      const isSuccessPage =
        applyPage.url().includes('/apply/success') ||
        applyPage.url().includes('/applied') ||
        (await applyPage.locator('text=Application sent').isVisible().catch(() => false)) ||
        (await applyPage.locator('[data-automation="application-sent"]').isVisible().catch(() => false));
      if (isSuccessPage) {
        console.log('  Applied! (success page detected)');
        if (newPage) await newPage.close().catch(() => {});
        return { success: true, variant: finalVariant };
      }

      const submitBtn = applyPage
        .locator('[data-automation="summary-submit"]')
        .or(applyPage.locator('button').filter({ hasText: /submit (my )?application/i }))
        .first();
      if (await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await submitBtn.scrollIntoViewIfNeeded();
        await submitBtn.click();
        console.log('  Applied!');
        if (newPage) await newPage.close().catch(() => {});
        return { success: true, variant: finalVariant };
      }

      const unanswered = await answerEmployerQuestions(applyPage, config.kb);
      if (unanswered.length > 0) {
        console.log(`  ${unanswered.length} question(s) could not be auto-answered`);
        await captureAndAnalyze(applyPage, 'unanswered_questions', ctx);
        await handleUnansweredQuestions(applyPage, unanswered, config.kb, ctx);
        saveToReviewQueue(applyPage.url(), unanswered, ctx);
        await applyPage.waitForTimeout(1_000);
      }

      const heading = (await applyPage.locator('h1, h2, [data-automation="page-title"]').first().textContent().catch(() => '(no heading)'))?.trim() ?? '';
      console.log(`  Page ${attempt + 1}: '${heading}' - clicking Continue`);

      const isAuthPage =
        /apple account|sign in to seek|google account|sign in with/i.test(heading) ||
        applyPage.url().includes('appleid.apple.com') ||
        applyPage.url().includes('accounts.google.com');
      if (isAuthPage) {
        console.log('  Landed on an auth page - skipping this job');
        await captureAndAnalyze(applyPage, 'unexpected_auth_page', ctx);
        earlyFailureReason = 'unexpected_auth_page';
        break;
      }

      const continued = await clickContinue(applyPage, ctx);
      if (!continued) {
        console.log('  No Continue button found');
        if (process.stdin.isTTY) {
          const action = await askUser('  [Enter = skip this job | r = give me 15s to fix it in the browser]: ');
          if (action.trim().toLowerCase() === 'r') {
            console.log('  Waiting 15 seconds - fix what you need in the browser...');
            await applyPage.waitForTimeout(15_000);
            attempt--;
            continue;
          }
        }
        earlyFailureReason = 'continue_button_not_found';
        break;
      }

      await applyPage.waitForTimeout(1_500);
      const validationBlocked = await applyPage.locator('text=Before you can continue').isVisible().catch(() => false);
      if (validationBlocked) {
        console.log('  Validation errors blocking form - re-scanning unfilled fields');
        await captureAndAnalyze(applyPage, 'validation_errors_blocking_continue', ctx);
        const blocked = await answerEmployerQuestions(applyPage, config.kb);
        if (blocked.length > 0) {
          await handleUnansweredQuestions(applyPage, blocked, config.kb, ctx);
          saveToReviewQueue(applyPage.url(), blocked, ctx);
        }
        const stillBlocked = await applyPage.locator('text=Before you can continue').isVisible().catch(() => false);
        if (stillBlocked && process.stdin.isTTY) {
          const action = await askUser('  Still blocked. [r = 15s to fix manually | Enter = skip job]: ');
          if (action.trim().toLowerCase() === 'r') {
            console.log('  Waiting 15 seconds...');
            await applyPage.waitForTimeout(15_000);
            attempt--;
            continue;
          }
          break;
        } else if (stillBlocked) {
          await captureAndAnalyze(applyPage, 'auto_skip_still_blocked', ctx);
          earlyFailureReason = 'validation_still_blocked';
          break;
        }
      }
    }

    if (!earlyFailureReason) {
      console.log('  Could not reach Submit after 5 pages - skipping');
      await captureAndAnalyze(applyPage, 'auto_skip_page_limit', ctx);
    }
    if (newPage) await newPage.close().catch(() => {});
    return { success: false, failureReason: earlyFailureReason ?? 'page_limit_exceeded' };
  }

  /** Run login flow and session setup. Called from scripts/apply.ts before the main loop. */
  async loginAndVerify(page: Page): Promise<boolean> {
    await page.goto('https://www.seek.com.au');
    await page.waitForTimeout(1_000);
    await login(page);
    if (await isSessionExpired(page)) {
      logger.error('seek session expired after login attempt — aborting run', {
        hint: 'Re-run `npm run seek-login` locally to refresh the session.',
      });
      return false;
    }
    // Clean up tailored resumes from previous runs so SEEK's 5-document limit
    // does not block uploads during this run.
    if (process.env.RESUME_TAILORING_ENABLED === 'true') {
      await cleanTailoredResumes(page);
    }
    return true;
  }

  /** Expose readBaseCoverLetter so apply.ts doesn't need to know about SEEK internals. */
  readBaseCoverLetter(): string {
    return readBaseCoverLetter();
  }
}
