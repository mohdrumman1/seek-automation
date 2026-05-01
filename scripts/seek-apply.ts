// Usage: npm run seek
// Automates job applications on seek.com.au for Project Manager and Software Engineer roles.
// Migrated from seek_bot.py (Selenium) to Playwright with two key bug fixes:
//   1. BrowserContext never crashes mid-session (fixes NoSuchWindowException)
//   2. locator.isVisible() never throws on detached elements (fixes NoneType.is_displayed())

import 'dotenv/config';
import { chromium, Browser, BrowserContext, Page, Locator } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { readBaseCoverLetter } from '../lib/cover-letter';
import { tailorCoverLetter, callOpenRouter } from '../lib/openrouter';
import { loadKB, saveKB, findKBAnswer, aiAnswerQuestion, selectBestOption } from '../lib/questions-kb';
import { getOrCreateSession, saveSession } from '../lib/seek-session';
import { captureAndAnalyze, getPastAnalyses } from '../lib/error-analyzer';

// ── CONFIG (from seek_bot.py lines 22-70) ─────────────────────────────────────
const SEEK_EMAIL = process.env.SEEK_EMAIL ?? 'mohdrumman1@gmail.com';
const APPLIED_LOG = path.resolve(__dirname, '../data/applied_jobs.json');

const CANDIDATE_PROFILE = `
Name: Rumman Riyaz
Location: Sydney, Australia (open to on-site and hybrid)
Work rights: Family/partner visa with no restrictions
Notice period: 2 weeks
Expected salary: $110,000 - $150,000 AUD + superannuation
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
Willing to relocate: No (Sydney-based)
`;

const SEARCHES = [
  {
    name: 'Project Manager',
    url: 'https://www.seek.com.au/project-manager-jobs-in-information-communication-technology?daterange=3&pos=1&salaryrange=100000-&salarytype=annual&savedsearchid=f85ff02f-5cbb-4b3d-bc6e-37fa4520d6fc&sitekey=AU-Main&workarrangement=2%2C3&worktype=242%2C244',
    resumeName: 'Rumman_Riyaz_Project_Manager_Resume',
  },
  {
    name: 'Software Engineer',
    url: 'https://www.seek.com.au/software-engineer-jobs-in-information-communication-technology?daterange=3&salaryrange=100000-&salarytype=annual&workarrangement=2%2C3&worktype=242%2C244',
    resumeName: 'Rumman_Riyaz_SE_Role',
  },
];

const MAX_APPS_PER_SEARCH = 10;
const DELAY_BETWEEN_APPS_MS = 6_000;
// ──────────────────────────────────────────────────────────────────────────────

// Set by applyToJob so error-analyzer helpers have context without threading it everywhere
let currentJobCtx: { job_title?: string; company?: string } = {};

interface UnansweredQuestion {
  label: string;
  type: 'select' | 'textarea' | 'input';
  options?: string[];
}

const REVIEW_QUEUE_PATH = path.resolve(__dirname, '../data/review-queue.json');

// ── UTILS ────────────────────────────────────────────────────────────────────
async function askUser(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => rl.question(prompt, (ans) => { rl.close(); resolve(ans); }));
}

function saveToReviewQueue(url: string, unanswered: UnansweredQuestion[]): void {
  let queue: unknown[] = [];
  if (fs.existsSync(REVIEW_QUEUE_PATH)) {
    try { queue = JSON.parse(fs.readFileSync(REVIEW_QUEUE_PATH, 'utf-8')) as unknown[]; } catch {}
  }
  queue.push({
    timestamp: new Date().toISOString(),
    job_title: currentJobCtx.job_title,
    company: currentJobCtx.company,
    url,
    unanswered,
    resolved: false,
  });
  fs.writeFileSync(REVIEW_QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf-8');
  console.log(`  [ReviewQueue] Saved ${unanswered.length} unanswered question(s) to data/review-queue.json`);
}

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
      console.log(`  Filled "${q.label}" with "${best}"`);
      return true;
    }
  }
  if (q.type === 'textarea') {
    for (const ta of await page.locator('textarea').all()) {
      const lbl = await getQuestionLabel(page, ta).catch(() => '');
      if (!labelMatch(lbl)) continue;
      await ta.fill(answer).catch(() => {});
      console.log(`  Filled "${q.label}" with "${answer.slice(0, 60)}"`);
      return true;
    }
  }
  if (q.type === 'input') {
    for (const inp of await page.locator('input[type="text"], input[type="number"]').all()) {
      const lbl = await getQuestionLabel(page, inp).catch(() => '');
      if (!labelMatch(lbl)) continue;
      await inp.fill(answer).catch(() => {});
      console.log(`  Filled "${q.label}" with "${answer}"`);
      return true;
    }
  }
  return false;
}

async function handleUnansweredQuestions(
  page: Page,
  unanswered: UnansweredQuestion[],
  kb: ReturnType<typeof loadKB>
): Promise<void> {
  if (unanswered.length === 0) return;

  if (!process.stdin.isTTY) {
    // Autonomous mode: force AI answer for each unanswered question
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
        saveKB(kb);
        const filled = await fillFieldByLabel(page, q, answer.trim());
        console.log(`  [Auto] "${q.label.slice(0, 50)}" → "${answer.trim().slice(0, 40)}"${filled ? '' : ' (fill failed)'}`);
      }
    }
    saveToReviewQueue(page.url(), unanswered);
    return;
  }

  console.log(`\n  --- BOT NEEDS YOUR HELP (${unanswered.length} unanswered question(s)) ---`);
  console.log('  Check the screenshot in screenshots/errors/ for context.');
  console.log('  Your answers will be saved and used automatically next time.\n');

  for (const q of unanswered) {
    console.log(`  Question: "${q.label}"`);
    if (q.options && q.options.length > 0) {
      const readable = q.options.filter((o) => o.trim()).join(' | ');
      console.log(`  Options:  ${readable}`);
    }
    const answer = await askUser('  Your answer (Enter to skip): ');
    if (!answer.trim()) {
      console.log('  Skipped.\n');
      continue;
    }

    // Save to KB so the bot remembers for next time
    const keywords = q.label
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3)
      .slice(0, 6);
    kb.push({ keywords, answer: answer.trim() });
    saveKB(kb);
    console.log('  Saved to knowledge base.');

    // Fill the field on the current page
    const filled = await fillFieldByLabel(page, q, answer.trim());
    if (!filled) console.log(`  Could not locate field on page - will be applied next run.`);
    console.log();
  }
}

// ── APPLIED JOBS LOG ─────────────────────────────────────────────────────────
function loadApplied(): Set<string> {
  if (fs.existsSync(APPLIED_LOG)) {
    return new Set(JSON.parse(fs.readFileSync(APPLIED_LOG, 'utf-8')) as string[]);
  }
  return new Set();
}

function saveApplied(applied: Set<string>): void {
  fs.writeFileSync(APPLIED_LOG, JSON.stringify([...applied]), 'utf-8');
}

// ── LOGIN ────────────────────────────────────────────────────────────────────
async function isLoggedIn(page: Page): Promise<boolean> {
  // Look for the authenticated user menu (present on all pages when logged in)
  const count = await page
    .locator('[data-automation="user-menu"], [data-automation="authenticated"], [aria-label="Account"], nav [href*="/profile"]')
    .count();
  return count > 0;
}

async function login(page: Page): Promise<void> {
  // Navigate to home and wait for it to settle before checking auth state
  await page.goto('https://www.seek.com.au', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3_000);

  if (await isLoggedIn(page)) {
    console.log('Already logged in via saved session.');
    return;
  }

  // Not logged in - go to login page and wait 30 seconds for manual login
  console.log('\nNot logged in. Opening Seek login page...');
  await page.goto('https://www.seek.com.au/oauth/login?returnUrl=https%3A%2F%2Fwww.seek.com.au%2F', {
    waitUntil: 'domcontentloaded',
  });

  // Try to pre-fill email to speed things up
  const emailField = page.locator('#email');
  if (await emailField.isVisible({ timeout: 4_000 }).catch(() => false)) {
    await emailField.fill(SEEK_EMAIL);
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(2_000);
  }

  // Handle OTP if shown
  const otpField = page.locator(
    'input[autocomplete="one-time-code"], input[name="code"], input[type="number"]'
  );
  if (await otpField.isVisible({ timeout: 5_000 }).catch(() => false)) {
    console.log('\nSeek sent a verification code to your email.');
    const code = await askUser('Enter the code here and press Enter: ');
    await otpField.fill(code.trim());
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(3_000);
  } else {
    // No OTP field - give user 30 seconds to complete login manually in the browser
    console.log('\nPlease log in to Seek in the browser window.');
    console.log('Waiting 30 seconds before continuing...\n');
    for (let i = 30; i > 0; i -= 5) {
      await page.waitForTimeout(5_000);
      const loggedInNow = await isLoggedIn(page);
      if (loggedInNow) {
        console.log('Login detected - continuing.');
        return;
      }
      if (i > 5) console.log(`  ${i - 5} seconds remaining...`);
    }
  }

  if (await isLoggedIn(page)) {
    console.log('Logged in successfully.');
  } else {
    console.log('Warning: could not confirm login. Proceeding anyway.');
  }
}

// ── JOB LINKS ────────────────────────────────────────────────────────────────
async function getJobLinks(page: Page): Promise<string[]> {
  try {
    await page.waitForSelector(
      '[data-automation="normalJob"], [data-automation="premiumJob"]',
      { timeout: 15_000 }
    );
  } catch {
    console.log('  No job cards found.');
    return [];
  }

  const links = await page.$$eval(
    '[data-automation="normalJob"] a[href*="/job/"], [data-automation="premiumJob"] a[href*="/job/"], ' +
    '[data-automation="normalJob"] [data-automation="job-list-view-job-link"], ' +
    '[data-automation="premiumJob"] [data-automation="job-list-view-job-link"]',
    (els) => {
      const hrefs = (els as HTMLAnchorElement[])
        .map((a) => a.href)
        .filter((h) => h.includes('/job/'))
        .map((h) => h.split('?')[0]);
      return [...new Set(hrefs)];
    }
  );
  return links;
}

// ── JOB DETAILS ──────────────────────────────────────────────────────────────
async function getJobDetails(
  page: Page
): Promise<{ title: string; company: string; description: string }> {
  const title = await page
    .locator('[data-automation="job-detail-title"], h1')
    .first()
    .textContent()
    .catch(() => 'Unknown Role') ?? 'Unknown Role';
  const company = await page
    .locator('[data-automation="advertiser-name"], [data-automation="job-company-name"]')
    .first()
    .textContent()
    .catch(() => 'Unknown Company') ?? 'Unknown Company';
  const description = await page
    .locator('[data-automation="jobAdDetails"]')
    .textContent()
    .catch(() => '') ?? '';
  return { title: title.trim(), company: company.trim(), description };
}

// ── EXTERNAL CHECK ────────────────────────────────────────────────────────────
async function isExternal(page: Page): Promise<boolean> {
  if ((await page.locator('[data-automation="job-detail-apply-external"]').count()) > 0) {
    return true;
  }
  const applyBtns = page.locator('[data-automation*="apply"]');
  const count = await applyBtns.count();
  for (let i = 0; i < count; i++) {
    const text = (await applyBtns.nth(i).textContent() ?? '').toLowerCase();
    if (text.includes('advertiser') || text.includes('company website') || text.includes('external')) {
      return true;
    }
  }
  return false;
}

// ── QUESTION LABEL ────────────────────────────────────────────────────────────
async function getQuestionLabel(page: Page, locator: Locator): Promise<string> {
  // aria-label directly on element (Seek Yes/No selects often use this)
  const ariaLabel = await locator.getAttribute('aria-label').catch(() => null);
  if (ariaLabel?.trim()) return ariaLabel.trim();

  // aria-labelledby
  const labelledBy = await locator.getAttribute('aria-labelledby').catch(() => null);
  if (labelledBy) {
    const text = await page.locator(`#${labelledBy}`).textContent().catch(() => '');
    if (text?.trim()) return text.trim();
  }
  // label[for=id]
  const id = await locator.getAttribute('id').catch(() => null);
  if (id) {
    const text = await page.locator(`label[for="${id}"]`).textContent().catch(() => '');
    if (text?.trim()) return text.trim();
  }
  // Walk up DOM for nearest label/legend
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

// ── RESUME SELECT ─────────────────────────────────────────────────────────────
async function selectResume(page: Page, resumeName: string): Promise<void> {
  const changeRadio = page.locator('input[name="resume-method"][value="change"]');
  if (await changeRadio.isVisible().catch(() => false)) {
    await changeRadio.click();
    await page.waitForTimeout(500);
    console.log('  Resume mode: use uploaded resume');
  }

  const dropdown = page.locator('select').first();
  if (!(await dropdown.waitFor({ timeout: 8_000 }).then(() => true).catch(() => false))) {
    console.log('  Resume dropdown not found');
    await captureAndAnalyze(page, 'resume_dropdown_not_found', currentJobCtx);
    return;
  }

  const options = await dropdown.locator('option').allTextContents();
  const keywords = new Set(
    resumeName
      .toLowerCase()
      .split(/[_\s.]+/)
      .filter((w) => !['rumman', 'riyaz', 'docx', ''].includes(w))
  );
  let bestIdx = options.length > 1 ? 1 : 0;
  let bestScore = 0;
  options.forEach((text, i) => {
    const words = new Set(text.toLowerCase().split(/[_\s.\-]+/));
    const score = [...keywords].filter((k) => words.has(k)).length;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });
  await dropdown.selectOption({ index: bestIdx });
  console.log(`  Resume selected: ${options[bestIdx] ?? bestIdx}`);
}

// ── COVER LETTER FILL ─────────────────────────────────────────────────────────
async function fillCoverLetter(page: Page, text: string): Promise<boolean> {
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

  // Fallback: rich text editor (contenteditable div - e.g. Quill, TipTap, Draft.js)
  // Learned from past analyses mentioning rich text / contenteditable
  const past = getPastAnalyses('cover_letter_fill_failed');
  const richTextLikely =
    past.length === 0 || // try on first encounter too
    past.some((a) =>
      /contenteditable|rich.?text|quill|tiptap|draft|editor/i.test(a)
    );

  if (richTextLikely) {
    const richText = page
      .locator('[contenteditable="true"]:not([aria-hidden="true"])')
      .first();
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
  await captureAndAnalyze(page, 'cover_letter_fill_failed', currentJobCtx);
  return false;
}

// ── ANSWER EMPLOYER QUESTIONS ─────────────────────────────────────────────────
async function answerEmployerQuestions(
  page: Page,
  kb: ReturnType<typeof loadKB>
): Promise<UnansweredQuestion[]> {
  const unanswered: UnansweredQuestion[] = [];

  // Dropdowns
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
      findKBAnswer(label, kb) ??
      (await aiAnswerQuestion(label, options, kb, CANDIDATE_PROFILE));
    if (answer) {
      const best = selectBestOption(options, answer);
      let filled = false;
      try {
        await sel.selectOption({ label: best });
        const newVal = await sel.inputValue().catch(() => '');
        filled = !!newVal;
      } catch {}
      if (!filled) unanswered.push({ label, type: 'select', options: options.filter((o) => o.trim()) });
    } else {
      unanswered.push({ label, type: 'select', options: options.filter((o) => o.trim()) });
    }
  }

  // Textareas (skip cover letter - already filled)
  for (const ta of await page.locator('textarea').all()) {
    if (!(await ta.isVisible().catch(() => false))) continue;
    const current = await ta.inputValue().catch(() => '');
    if (current) continue;
    const label = await getQuestionLabel(page, ta);
    if (!label) continue;
    const answer =
      findKBAnswer(label, kb) ?? (await aiAnswerQuestion(label, null, kb, CANDIDATE_PROFILE));
    if (answer) {
      await ta.fill(answer).catch(() => {});
    } else {
      unanswered.push({ label, type: 'textarea' });
    }
  }

  // Text / number inputs
  for (const inp of await page.locator('input[type="text"], input[type="number"]').all()) {
    if (!(await inp.isVisible().catch(() => false))) continue;
    const current = await inp.inputValue().catch(() => '');
    if (current) continue;
    const label = await getQuestionLabel(page, inp);
    if (!label) continue;
    const answer =
      findKBAnswer(label, kb) ?? (await aiAnswerQuestion(label, null, kb, CANDIDATE_PROFILE));
    if (answer) {
      const type = await inp.getAttribute('type');
      if (type === 'number') {
        const nums = answer.match(/\d+/);
        await inp.fill(nums ? nums[0] : answer).catch(() => {});
      } else {
        await inp.fill(answer).catch(() => {});
      }
    } else {
      unanswered.push({ label, type: 'input' });
    }
  }

  return unanswered;
}

// ── CLICK CONTINUE ────────────────────────────────────────────────────────────
async function clickContinue(page: Page): Promise<boolean> {
  const skipWords = [
    'back', 'cancel', 'close', 'exit', 'save draft', 'sign in', 'log in',
    'review and submit', 'answer employer', 'update seek', 'choose document',
    'with apple', 'with google', 'sign in with', 'continue with apple',
    'sign in with iphone', 'use passkey',
  ];

  // Primary: strict continue/next/proceed (excludes review/submit)
  const continueBtn = page.locator('button').filter({
    hasText: /^(continue|next|proceed)$/i,
  });
  if (await continueBtn.first().isVisible({ timeout: 10_000 }).catch(() => false)) {
    await continueBtn.first().scrollIntoViewIfNeeded();
    await continueBtn.first().click();
    return true;
  }

  // Fallback: last visible enabled button not in skip list
  const allBtns = page.locator('button');
  const count = await allBtns.count();
  for (let i = count - 1; i >= 0; i--) {
    const btn = allBtns.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue; // Bug Fix 2: never throws
    if (!(await btn.isEnabled().catch(() => false))) continue;
    const text = (await btn.textContent() ?? '').toLowerCase().trim();
    if (!text) continue;
    if (skipWords.some((w) => text.includes(w))) continue;
    console.log(`  clickContinue fallback: clicking '${text}'`);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    return true;
  }

  const allTexts: string[] = [];
  const btnCount = await allBtns.count();
  for (let i = 0; i < btnCount; i++) {
    const t = (await allBtns.nth(i).textContent() ?? '').trim();
    if (t) allTexts.push(t);
  }
  console.log(`  clickContinue FAILED. Buttons on page: ${allTexts.join(', ')}`);
  await captureAndAnalyze(page, 'continue_button_not_found', currentJobCtx);
  return false;
}

// ── APPLY TO JOB ─────────────────────────────────────────────────────────────
async function applyToJob(
  page: Page,
  context: BrowserContext,
  resumeName: string,
  baseCoverLetter: string,
  kb: ReturnType<typeof loadKB>
): Promise<boolean> {
  if (await isExternal(page)) {
    console.log('  Skipping - external application (advertiser\'s site)');
    return false;
  }

  const { title, company, description } = await getJobDetails(page);
  currentJobCtx = { job_title: title, company };
  console.log(`  Applying: ${title} @ ${company}`);

  const applyBtn = page
    .locator(
      '[data-automation="job-detail-apply"], ' +
      '[data-automation="job-detail-apply-button"], ' +
      'a[data-automation*="apply"]'
    )
    .first();

  if (!(await applyBtn.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false))) {
    console.log('  Apply button not found - skipping');
    return false;
  }

  // Bug Fix 1: Use context.waitForEvent to handle new tabs cleanly
  // Replaces seek_bot.py window_handles juggling that caused NoSuchWindowException
  let newPage: Page | null = null;
  const [maybeNewPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 3_000 }).catch(() => null),
    applyBtn.click(),
  ]);
  newPage = maybeNewPage;

  const applyPage = newPage ?? page;
  await applyPage.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  if (!applyPage.url().includes('seek.com.au')) {
    console.log(`  Skipping - Apply redirected to external: ${applyPage.url().slice(0, 60)}`);
    if (newPage) await newPage.close().catch(() => {});
    return false;
  }

  // Tailor cover letter while form loads
  const tailored = await tailorCoverLetter(baseCoverLetter, title, company, description);

  await applyPage.waitForTimeout(2_000);

  // Page 1: Resume + Cover Letter
  await selectResume(applyPage, resumeName);
  await applyPage.waitForTimeout(500);

  const clChangeRadio = applyPage.locator('input[name="coverLetter-method"][value="change"]');
  if (await clChangeRadio.isVisible().catch(() => false)) {
    await clChangeRadio.click();
    await applyPage.waitForTimeout(500);
    console.log('  Cover letter mode: enter text');
  }

  await fillCoverLetter(applyPage, tailored);

  // Check for validation errors before clicking Continue
  const errsBefore = await getValidationErrors(applyPage);
  if (errsBefore.length) console.log(`  Form errors before Continue: ${errsBefore.slice(0, 3)}`);

  await clickContinue(applyPage);

  const errsAfter = await getValidationErrors(applyPage);
  if (errsAfter.length) console.log(`  Validation errors after Continue (page 1 blocked): ${errsAfter.slice(0, 3)}`);

  // Pages 2-5: Questions → Review → Submit
  for (let attempt = 0; attempt < 5; attempt++) {
    await applyPage.waitForTimeout(2_000);

    const submitBtn = applyPage
      .locator('[data-automation="summary-submit"]')
      .or(applyPage.locator('button').filter({ hasText: /submit (my )?application/i }))
      .first();

    if (await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await submitBtn.scrollIntoViewIfNeeded();
      await submitBtn.click();
      console.log('  Applied!');
      if (newPage) await newPage.close().catch(() => {});
      return true;
    }

    const unanswered = await answerEmployerQuestions(applyPage, kb);

    if (unanswered.length > 0) {
      console.log(`  ${unanswered.length} question(s) could not be auto-answered`);
      await captureAndAnalyze(applyPage, 'unanswered_questions', currentJobCtx);
      await handleUnansweredQuestions(applyPage, unanswered, kb);
      saveToReviewQueue(applyPage.url(), unanswered);
      await applyPage.waitForTimeout(1_000);
    }

    const heading = await applyPage
      .locator('h1, h2, [data-automation="page-title"]')
      .first()
      .textContent()
      .catch(() => '(no heading)');
    const headingText = heading?.trim() ?? '';
    console.log(`  Page ${attempt + 1}: '${headingText}' - clicking Continue`);

    // Bail if we've landed on an auth/SSO page (Apple, Google sign-in, etc.)
    const isAuthPage =
      /apple account|sign in to seek|google account|sign in with/i.test(headingText) ||
      applyPage.url().includes('appleid.apple.com') ||
      applyPage.url().includes('accounts.google.com');

    if (isAuthPage) {
      console.log('  Landed on an auth page - skipping this job');
      await captureAndAnalyze(applyPage, 'unexpected_auth_page', currentJobCtx);
      break;
    }

    const continued = await clickContinue(applyPage);
    if (!continued) {
      console.log('  No Continue button found');
      if (process.stdin.isTTY) {
        const action = await askUser(
          '  [Enter = skip this job | r = give me 15s to fix it in the browser]: '
        );
        if (action.trim().toLowerCase() === 'r') {
          console.log('  Waiting 15 seconds - fix what you need in the browser...');
          await applyPage.waitForTimeout(15_000);
          attempt--;
          continue;
        }
      }
      break;
    }

    // Check if Seek showed validation errors (page didn't advance)
    await applyPage.waitForTimeout(1_500);
    const validationBlocked = await applyPage
      .locator('text=Before you can continue')
      .isVisible()
      .catch(() => false);

    if (validationBlocked) {
      console.log('  Validation errors blocking form - re-scanning unfilled fields');
      await captureAndAnalyze(applyPage, 'validation_errors_blocking_continue', currentJobCtx);
      const blocked = await answerEmployerQuestions(applyPage, kb);
      if (blocked.length > 0) {
        await handleUnansweredQuestions(applyPage, blocked, kb);
        saveToReviewQueue(applyPage.url(), blocked);
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
        break;
      }
    }
  }

  console.log('  Could not reach Submit after 5 pages - skipping');
  if (newPage) await newPage.close().catch(() => {});
  return false;
}

// ── VALIDATION ERRORS ─────────────────────────────────────────────────────────
async function getValidationErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  const sels = ["[role='alert']", "[aria-live='polite']", "[data-automation*='error']", '.error-message'];
  for (const sel of sels) {
    const items = await page.locator(sel).all();
    for (const el of items) {
      if (await el.isVisible().catch(() => false)) {
        const t = (await el.textContent() ?? '').trim();
        if (t) errors.push(t);
      }
    }
  }
  return errors;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Seek Auto Apply Bot (Playwright) ===');

  const baseCoverLetter = readBaseCoverLetter();
  const applied = loadApplied();
  const kb = loadKB();
  console.log(`Previously applied to ${applied.size} jobs (will skip these)`);
  console.log(`Questions KB loaded: ${kb.length} entries\n`);

  const interactive = process.stdin.isTTY === true;
  const browser: Browser = await chromium.launch({
    headless: !interactive,
    args: interactive ? ['--start-maximized'] : [],
  });

  const context = await getOrCreateSession(browser);
  const page = await context.newPage();

  try {
    await page.goto('https://www.seek.com.au');
    await page.waitForTimeout(1_000);
    await login(page);
    await saveSession(context);

    let total = 0;

    for (const search of SEARCHES) {
      console.log(`\n=== ${search.name} ===`);
      await page.goto(search.url);
      await page.waitForTimeout(2_000);

      const links = await getJobLinks(page);
      console.log(`Found ${links.length} jobs on this page`);

      let count = 0;
      for (const url of links) {
        if (count >= MAX_APPS_PER_SEARCH) {
          console.log(`  Reached max ${MAX_APPS_PER_SEARCH} for this search.`);
          break;
        }

        const jobId = url.match(/\/job\/(\d+)/)?.[1] ?? url;
        if (applied.has(jobId)) {
          console.log(`  Already applied to ${jobId} - skipping`);
          continue;
        }

        await page.goto(url);
        await page.waitForTimeout(2_000);

        let success = false;
        try {
          success = await applyToJob(page, context, search.resumeName, baseCoverLetter, kb);
        } catch (e) {
          console.error(`  Error on ${url}: ${(e as Error).message}`);
          await captureAndAnalyze(page, 'unexpected_error', currentJobCtx).catch(() => {});
        }

        // Close any stray tabs that weren't cleaned up inside applyToJob
        for (const p of context.pages()) {
          if (p !== page) await p.close().catch(() => {});
        }

        if (success) {
          applied.add(jobId);
          saveApplied(applied);
          count++;
          total++;
          await page.waitForTimeout(DELAY_BETWEEN_APPS_MS);
        }
      }
    }

    console.log(`\n=== Done. Applied to ${total} jobs this run. ===`);
  } finally {
    await saveSession(context);
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
