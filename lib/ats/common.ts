import * as fs from 'fs';
import * as path from 'path';
import { Page, Locator } from '@playwright/test';
import { ApplyConfig } from '../platforms/types';
import { findKBAnswer, aiAnswerQuestion, aiAnswerCheckboxes, selectBestOption } from '../questions-kb';
import { logger } from '../logger';

// Structured contact data for ATS form fields.
// Keep in sync with seek.ts CANDIDATE_PROFILE (phone/linkedin/email).
export const ATS_CONTACT = {
  firstName: 'Rumman',
  lastName:  'Riyaz',
  fullName:  'Rumman Riyaz',
  email:     process.env.SEEK_EMAIL    ?? 'mohdrumman1@gmail.com',
  phone:     process.env.CANDIDATE_PHONE   ?? '0474199245',
  city:      'Newcastle',
  state:     'NSW',
  country:   'Australia',
  postcode:  '2300',
  linkedin:  process.env.CANDIDATE_LINKEDIN ?? 'https://www.linkedin.com/in/rumman-riyaz/',
  website:   process.env.CANDIDATE_WEBSITE  ?? 'https://rummanriyaz.com/',
};

// Free-text profile for ATS employer-question AI answers.
export const CANDIDATE_PROFILE_ATS = `
Name: Rumman Riyaz
Location: Newcastle/Sydney/Brisbane, NSW and QLD (open to remote and hybrid)
Work rights: Family/partner visa with no restrictions
Notice period: 2 weeks
Expected salary: $120,000 - $150,000 AUD + superannuation
Expected daily rate (contract/day rate roles): $700 AUD per day (range $650–$750), excluding GST
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
Phone: ${ATS_CONTACT.phone}
LinkedIn: ${ATS_CONTACT.linkedin}
Website: ${ATS_CONTACT.website}
`.trim();

// Labels that must never be auto-filled — return needs_manual_review if required.
const SENSITIVE_RE =
  /\b(tax file number|\bTFN\b|passport (number|no)|date of birth|\bDOB\b|bank (account|details|bsb)|\bBSB\b|account number|medicare|driver'?s licen[cs]e number|superannuation (fund|member) number|visa (grant|subclass) number)\b/i;

// ── HELPERS ───────────────────────────────────────────────────────────────────

export async function acceptCookies(page: Page): Promise<void> {
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("Accept cookies")',
    'button:has-text("Accept")',
    '[data-cookie-consent] button',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(500);
      return;
    }
  }
}

// Shared label-resolution logic — mirrors seek.ts getQuestionLabel.
export async function getQuestionLabel(page: Page, locator: Locator): Promise<string> {
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

// Fill the first unfilled input whose composite label (aria-label + name + id) matches a hint.
export async function fillTextByHints(
  page: Page,
  hints: RegExp[],
  value: string,
): Promise<boolean> {
  if (!value) return false;
  const inputs = await page.locator(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input:not([type])'
  ).all();
  for (const inp of inputs) {
    if (!(await inp.isVisible().catch(() => false))) continue;
    const existing = await inp.inputValue().catch(() => '');
    if (existing) continue;
    const label = (await getQuestionLabel(page, inp).catch(() => '')) + ' ' +
                  (await inp.getAttribute('name').catch(() => '') ?? '') + ' ' +
                  (await inp.getAttribute('id').catch(() => '') ?? '') + ' ' +
                  (await inp.getAttribute('placeholder').catch(() => '') ?? '');
    if (hints.some((h) => h.test(label))) {
      await inp.fill(value).catch(() => {});
      return true;
    }
  }
  return false;
}

// Fill a cover-letter textarea if one is found.
export async function fillCoverLetter(page: Page, coverLetter: string): Promise<void> {
  if (!coverLetter) return;
  const hints = /cover.?letter|message to employer|why.{0,20}apply|motivation/i;
  for (const ta of await page.locator('textarea').all()) {
    if (!(await ta.isVisible().catch(() => false))) continue;
    const existing = await ta.inputValue().catch(() => '');
    if (existing) continue;
    const label = await getQuestionLabel(page, ta).catch(() => '');
    if (hints.test(label)) {
      await ta.fill(coverLetter).catch(() => {});
      return;
    }
  }
}

// Upload a resume file to the first visible file input.
export async function uploadResumeFile(page: Page, filePath: string): Promise<boolean> {
  const input = page.locator('input[type="file"]').first();
  if ((await input.count()) === 0) return false;
  try {
    await input.setInputFiles(filePath);
    await page.waitForTimeout(2_000);
    logger.info('ats: resume uploaded', { file: path.basename(filePath) });
    return true;
  } catch (err) {
    logger.warn('ats: resume upload failed', { error: String(err) });
    return false;
  }
}

// Return the path to the base resume DOCX for the given variant.
export function getBaseResumePath(variant: string): string | null {
  const name = variant === 'se' ? 'se-base.docx' : 'pm-base.docx';
  const p = path.resolve(__dirname, '../../data/resumes', name);
  return fs.existsSync(p) ? p : null;
}

// Scan visible required fields for sensitive labels. Return the label if found.
export async function hasSensitiveRequiredField(page: Page): Promise<string | null> {
  for (const el of await page.locator('input, select, textarea').all()) {
    if (!(await el.isVisible().catch(() => false))) continue;
    const required =
      (await el.getAttribute('required').catch(() => null)) !== null ||
      (await el.getAttribute('aria-required').catch(() => null)) === 'true';
    if (!required) continue;
    const label = await getQuestionLabel(page, el).catch(() => '');
    if (SENSITIVE_RE.test(label)) return label.trim();
  }
  return null;
}

// Generic employer-question answering for any ATS form.
// Handles: select, textarea (non-cover-letter), text/number input, radio groups, checkbox groups.
export async function answerGenericQuestions(
  page: Page,
  kb: ApplyConfig['kb'],
): Promise<void> {
  // Select dropdowns
  for (const sel of await page.locator('select').all()) {
    if (!(await sel.isVisible().catch(() => false))) continue;
    const currentVal = await sel.inputValue().catch(() => '');
    if (currentVal) continue;
    const label = await getQuestionLabel(page, sel).catch(() => '');
    if (!label) continue;
    const options = await sel.locator('option').allTextContents();
    const answer = findKBAnswer(label, kb) ?? (await aiAnswerQuestion(label, options, kb, CANDIDATE_PROFILE_ATS));
    if (answer) {
      const best = selectBestOption(options, answer);
      await sel.selectOption({ label: best }).catch(() => {});
    }
  }

  // Textarea (non-cover-letter)
  const coverLetterRe = /cover.?letter|message to employer|why.{0,20}apply|motivation/i;
  for (const ta of await page.locator('textarea').all()) {
    if (!(await ta.isVisible().catch(() => false))) continue;
    const existing = await ta.inputValue().catch(() => '');
    if (existing) continue;
    const label = await getQuestionLabel(page, ta).catch(() => '');
    if (!label || coverLetterRe.test(label)) continue;
    const answer = findKBAnswer(label, kb) ?? (await aiAnswerQuestion(label, null, kb, CANDIDATE_PROFILE_ATS));
    if (answer) await ta.fill(answer).catch(() => {});
  }

  // Radio groups by name attribute
  const radioNames = new Set<string>();
  for (const r of await page.locator('input[type="radio"]').all()) {
    if (!(await r.isVisible().catch(() => false))) continue;
    const name = await r.getAttribute('name').catch(() => null);
    if (name) radioNames.add(name);
  }
  for (const name of radioNames) {
    const radios = page.locator(`input[type="radio"][name="${name}"]`);
    const count = await radios.count();
    if (count === 0) continue;
    const anyChecked = await (async () => {
      for (let i = 0; i < count; i++) {
        if (await radios.nth(i).isChecked().catch(() => false)) return true;
      }
      return false;
    })();
    if (anyChecked) continue;
    const label = await getQuestionLabel(page, radios.first()).catch(() => '');
    if (!label) continue;
    const optionLabels: string[] = [];
    for (let i = 0; i < count; i++) {
      const r = radios.nth(i);
      const id = await r.getAttribute('id').catch(() => null);
      let optLabel = '';
      if (id) optLabel = (await page.locator(`label[for="${id}"]`).textContent().catch(() => '')) ?? '';
      if (!optLabel.trim()) optLabel = (await r.getAttribute('value').catch(() => '')) ?? '';
      if (optLabel.trim()) optionLabels.push(optLabel.trim());
    }
    const answer = findKBAnswer(label, kb) ?? (await aiAnswerQuestion(label, optionLabels, kb, CANDIDATE_PROFILE_ATS));
    if (!answer) continue;
    const best = selectBestOption(optionLabels, answer);
    const bestLower = best.toLowerCase().trim();
    for (let i = 0; i < count; i++) {
      const r = radios.nth(i);
      const id = await r.getAttribute('id').catch(() => null);
      let optLabel = '';
      if (id) optLabel = (await page.locator(`label[for="${id}"]`).textContent().catch(() => '')) ?? '';
      if (!optLabel.trim()) optLabel = (await r.getAttribute('value').catch(() => '')) ?? '';
      if (optLabel.trim().toLowerCase() === bestLower) {
        if (id) {
          const lbl = page.locator(`label[for="${id}"]`);
          if (await lbl.isVisible().catch(() => false)) { await lbl.click().catch(() => {}); break; }
        }
        await r.click().catch(() => {});
        break;
      }
    }
  }

  // Checkbox groups by name attribute (multi-select skills/certs)
  const cbNames = new Set<string>();
  for (const cb of await page.locator('input[type="checkbox"]').all()) {
    if (!(await cb.isVisible().catch(() => false))) continue;
    const name = await cb.getAttribute('name').catch(() => null);
    if (name) cbNames.add(name);
  }
  for (const name of cbNames) {
    const boxes = page.locator(`input[type="checkbox"][name="${name}"]`);
    const count = await boxes.count();
    if (count < 2) continue;
    const anyChecked = await (async () => {
      for (let i = 0; i < count; i++) {
        if (await boxes.nth(i).isChecked().catch(() => false)) return true;
      }
      return false;
    })();
    if (anyChecked) continue;
    const label = await getQuestionLabel(page, boxes.first()).catch(() => '');
    if (!label) continue;
    const optionLabels: string[] = [];
    for (let i = 0; i < count; i++) {
      const cb = boxes.nth(i);
      const id = await cb.getAttribute('id').catch(() => null);
      let optLabel = '';
      if (id) optLabel = (await page.locator(`label[for="${id}"]`).textContent().catch(() => '')) ?? '';
      if (!optLabel.trim()) optLabel = (await cb.getAttribute('value').catch(() => '')) ?? '';
      if (optLabel.trim()) optionLabels.push(optLabel.trim());
    }
    const selections = await aiAnswerCheckboxes(label, optionLabels, CANDIDATE_PROFILE_ATS);
    if (selections.length === 0) continue;
    const selLower = selections.map((s) => s.toLowerCase().trim());
    for (let i = 0; i < count; i++) {
      const cb = boxes.nth(i);
      const id = await cb.getAttribute('id').catch(() => null);
      let optLabel = '';
      if (id) optLabel = (await page.locator(`label[for="${id}"]`).textContent().catch(() => '')) ?? '';
      if (!optLabel.trim()) optLabel = (await cb.getAttribute('value').catch(() => '')) ?? '';
      const o = optLabel.trim().toLowerCase();
      if (!o) continue;
      if (selLower.some((s) => o === s || o.includes(s) || s.includes(o))) {
        if (await cb.isChecked().catch(() => false)) continue;
        if (id) {
          const lbl = page.locator(`label[for="${id}"]`);
          if (await lbl.isVisible().catch(() => false)) { await lbl.click().catch(() => {}); continue; }
        }
        await cb.click().catch(() => {});
      }
    }
  }
}

// Click the first visible "Next" / "Continue" / "Save and Continue" button.
export async function clickNext(page: Page, extraSelectors?: string[]): Promise<boolean> {
  const selectors = [
    ...(extraSelectors ?? []),
    'button:has-text("Save and Continue")',
    'button:has-text("Next")',
    'button:has-text("Continue")',
    'input[type="submit"][value*="Next" i]',
    'input[type="submit"][value*="Continue" i]',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

// Click the first visible Submit button.
export async function clickSubmit(page: Page, extraSelectors?: string[]): Promise<boolean> {
  const selectors = [
    ...(extraSelectors ?? []),
    'button:has-text("Submit application")',
    'button:has-text("Submit Application")',
    'button:has-text("Submit")',
    'button[type="submit"]',
    'input[type="submit"][value*="Submit" i]',
    '#btnSubmit',
  ];
  for (const sel of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

// Check if the current page looks like a successful submission.
export async function isSuccessPage(page: Page, extraPatterns?: RegExp[]): Promise<boolean> {
  const url = page.url().toLowerCase();
  const urlPatterns = [
    /successfullysubmitted/,
    /confirmation/,
    /applicationsubmitted/,
    /thank.?you/,
    ...(extraPatterns ?? []),
  ];
  if (urlPatterns.some((p) => p.test(url))) return true;

  const textSelectors = [
    'h1:has-text("Thank you")',
    'h2:has-text("Thank you")',
    'h1:has-text("successfully submitted")',
    'h2:has-text("successfully submitted")',
    'h1:has-text("Application submitted")',
    'h2:has-text("Application submitted")',
    '[data-automation-id="confirmationPage"]',
    'text=application has been submitted',
    'text=application has been received',
    'text=Thanks for applying',
    'text=Your application has been sent',
  ];
  for (const sel of textSelectors) {
    if (await page.locator(sel).first().isVisible({ timeout: 1_500 }).catch(() => false)) return true;
  }
  return false;
}
