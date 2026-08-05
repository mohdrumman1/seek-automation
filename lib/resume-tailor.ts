import * as fs from 'fs';
import * as path from 'path';
import mammoth from 'mammoth';
import { callOpenRouter } from './openrouter';
import { logger } from './logger';
import type { ResumeVariant } from './resume-selector';

const RESUMES_DIR = path.resolve(__dirname, '../data/resumes');
const QUESTIONS_PATH = path.resolve(__dirname, '../data/resume-questions.json');
const FAILURE_COUNTS_PATH = path.resolve(__dirname, '../data/tailor_failure_counts.json');
const BLOCKED_JOBS_PATH = path.resolve(__dirname, '../data/blocked_jobs.json');

// After N consecutive AI-tailoring failures on the same job, add it to
// blocked_jobs.json so future runs skip it before wasting another AI call.
// Threshold intentionally small: 3 same-job failures across runs almost
// always means the JD is malformed or the model can't produce valid JSON
// for it — no amount of retrying will change that.
const TAILOR_FAILURE_THRESHOLD = 3;

// Job id used for blocklist/counter keys. MUST match the format used by
// scripts/apply.ts:172 (`url.match(/\/job\/(\d+)/)?.[1] ?? url`) so that an
// entry we add to data/blocked_jobs.json is also honored by the SEEK main
// loop's pre-nav skip check (apply.ts:174) — saving the page.goto too.
function jobIdForBlocklist(url: string): string {
  const seek = url.match(/\/job\/(\d+)/);
  if (seek) return seek[1];
  try {
    const p = new URL(url);
    return `${p.hostname}${p.pathname}`.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}

function loadFailureCounts(): Record<string, number> {
  if (!fs.existsSync(FAILURE_COUNTS_PATH)) return {};
  try {
    const raw = fs.readFileSync(FAILURE_COUNTS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveFailureCounts(counts: Record<string, number>): void {
  fs.writeFileSync(FAILURE_COUNTS_PATH, JSON.stringify(counts), 'utf-8');
}

function loadBlockedSet(): Set<string> {
  if (!fs.existsSync(BLOCKED_JOBS_PATH)) return new Set();
  try {
    const raw = fs.readFileSync(BLOCKED_JOBS_PATH, 'utf-8');
    const arr = JSON.parse(raw) as string[];
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function saveBlockedSet(blocked: Set<string>): void {
  fs.writeFileSync(BLOCKED_JOBS_PATH, JSON.stringify([...blocked]), 'utf-8');
}

// Wraps failure-count bookkeeping. Called on both AI network failure and
// AI-JSON-parse failure (both wasted the OpenRouter call).
function recordTailorFailure(jobId: string, jobTitle: string): void {
  const counts = loadFailureCounts();
  const next = (counts[jobId] ?? 0) + 1;
  counts[jobId] = next;
  saveFailureCounts(counts);
  logger.warn('resume-tailor: failure count incremented', {
    jobId, title: jobTitle, count: next, threshold: TAILOR_FAILURE_THRESHOLD,
  });
  if (next >= TAILOR_FAILURE_THRESHOLD) {
    const blocked = loadBlockedSet();
    if (!blocked.has(jobId)) {
      blocked.add(jobId);
      saveBlockedSet(blocked);
      logger.warn(
        `resume-tailor: blocklisted ${jobId} (${jobTitle}) after ${TAILOR_FAILURE_THRESHOLD} failed AI calls — added to blocked_jobs.json`,
        { jobId, title: jobTitle, count: next },
      );
    }
    // Counter can now be cleared — the blocklist gate takes over from here.
    delete counts[jobId];
    saveFailureCounts(counts);
  }
}

function clearTailorFailure(jobId: string): void {
  const counts = loadFailureCounts();
  if (counts[jobId] !== undefined) {
    delete counts[jobId];
    saveFailureCounts(counts);
  }
}

export interface ExperienceRole {
  company: string;
  role: string;
  period: string;
  bullets: string[];
}

export interface TailoredContent {
  matchScore: number;
  missingKeywords: string[];
  title: string;
  summary: string;
  skills: string;
  experience: ExperienceRole[];
  atsIssues: string[];
  questions: string[];
  variant: ResumeVariant;
}

// Words and patterns that signal AI-generated writing. Replace or flag.
const SLOP_REPLACEMENTS: [RegExp, string][] = [
  [/—/g, ','],
  [/\bleverage[sd]?\b/gi, 'use'],
  [/\bspearheaded\b/gi, 'led'],
  [/\bsynergi[sz]e[sd]?\b/gi, 'coordinated'],
  [/\bseamlessly\b/gi, 'smoothly'],
  [/\brobust\b/gi, 'reliable'],
  [/\bholistic\b/gi, 'comprehensive'],
  [/\bcutting-edge\b/gi, 'modern'],
  [/\btransformative\b/gi, 'significant'],
  [/\bpivotal\b/gi, 'key'],
  [/\bimpactful\b/gi, 'effective'],
  [/\bgame-changing\b/gi, 'significant'],
  [/\bin conclusion\b/gi, ''],
  [/\bpassionate about\b/gi, 'focused on'],
  [/\bexcited to\b/gi, 'aiming to'],
  [/\bthoughtful\b/gi, 'considered'],
  [/\bseek to\b/gi, 'aim to'],
  [/\bfoster\b/gi, 'build'],
  [/\bempower\b/gi, 'enable'],
  [/\bchampion(ed|ing)?\b/gi, 'promoted'],
  [/\binnovative solutions?\b/gi, 'solutions'],
  [/\bworld-class\b/gi, 'high-quality'],
  [/\bstate-of-the-art\b/gi, 'modern'],
];

function removeSlop(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SLOP_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  // Collapse double spaces and trailing spaces on each line
  out = out.split('\n').map((l) => l.replace(/ {2,}/g, ' ').trimEnd()).join('\n');
  return out.trim();
}

function stripJson(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const braceStart = raw.indexOf('{');
  const braceEnd = raw.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) return raw.slice(braceStart, braceEnd + 1);
  return raw.trim();
}

export async function extractResumeText(variant: ResumeVariant): Promise<string> {
  const file = path.join(RESUMES_DIR, `${variant}-base.docx`);
  if (!fs.existsSync(file)) {
    logger.warn('resume-tailor: base DOCX not found', { variant, file });
    return '';
  }
  const result = await mammoth.extractRawText({ path: file });
  return result.value.trim();
}

function logQuestions(
  questions: string[],
  ctx: { job_title?: string; company?: string; url?: string }
): void {
  if (questions.length === 0) return;
  let log: unknown[] = [];
  if (fs.existsSync(QUESTIONS_PATH)) {
    try { log = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf-8')) as unknown[]; } catch {}
  }
  log.push({
    timestamp: new Date().toISOString(),
    job_title: ctx.job_title ?? 'unknown',
    company: ctx.company ?? 'unknown',
    url: ctx.url ?? '',
    questions,
  });
  fs.writeFileSync(QUESTIONS_PATH, JSON.stringify(log, null, 2), 'utf-8');
  logger.warn('resume-tailor: AI had questions — logged to data/resume-questions.json', {
    count: questions.length,
    job: ctx.job_title,
  });
}

export async function tailorResume(
  variant: ResumeVariant,
  jobTitle: string,
  company: string,
  jobDescription: string,
  url: string,
): Promise<TailoredContent | null> {
  // Skip check: bail BEFORE any expensive work if this job has already
  // burned through the failure threshold on prior runs.
  const jobId = jobIdForBlocklist(url);
  const blocked = loadBlockedSet();
  if (blocked.has(jobId)) {
    logger.info(
      `resume-tailor: skipping ${jobId} (${jobTitle}) — blocklisted after ${TAILOR_FAILURE_THRESHOLD} failed AI calls`,
      { jobId, title: jobTitle, url },
    );
    return null;
  }

  const baseText = await extractResumeText(variant);
  if (!baseText) return null;

  const prompt = `You are a senior recruiter AND an ATS optimization expert. Tailor this resume for the job below.

CANDIDATE RESUME:
${baseText}

JOB TITLE: ${jobTitle}
COMPANY: ${company}
JOB DESCRIPTION:
${jobDescription.slice(0, 3000)}

YOUR TASKS:
1. Score the current resume match (0-100) and identify the top 5 missing ATS keywords.
2. Rewrite the Professional Summary (2-3 sentences, plain active voice, no padding).
3. Rewrite the Skills section to naturally lead with the most relevant skills for this role. Do not add skills the candidate does not have.
4. Rewrite the Experience bullets using the Google XYZ formula: "Accomplished [X], as measured by [Y], by doing [Z]." Embed the missing keywords naturally. Do not invent achievements, employers, dates, or qualifications.
5. Update the job title below the candidate's name to best match the role.
6. ATS scan: list any formatting issues that would cause a parser to misread the resume.
7. Questions: if any information you need is genuinely missing or ambiguous, list each question clearly.

STRICT RULES — violation is not acceptable:
- Never use em-dashes (—). Use a comma or a period instead.
- Never use these words: leverage, spearhead, synergize, seamlessly, robust, holistic, cutting-edge, transformative, pivotal, impactful, game-changing, champion, foster, empower, innovative solutions, world-class, state-of-the-art.
- Write the way a person writes, not the way a language model writes. Short sentences, active voice, specific numbers.
- Do not fabricate experience, qualifications, employers, dates, or metrics that are not in the original resume.

Return ONLY valid JSON (no markdown fences, no explanation) in this exact shape:
{
  "match_score": 85,
  "missing_keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "title": "Tailored job title string",
  "summary": "Two or three sentence summary.",
  "skills": "Full skills section text, formatted with category labels on separate lines.",
  "experience": [
    {
      "company": "Company name exactly as in original",
      "role": "Role title exactly as in original",
      "period": "Date period exactly as in original",
      "bullets": [
        "Accomplished X, as measured by Y, by doing Z.",
        "Second bullet."
      ]
    }
  ],
  "ats_issues": ["issue1"],
  "questions": ["question1"]
}`;

  let raw = '';
  try {
    raw = await callOpenRouter(prompt);
  } catch (err) {
    logger.error('resume-tailor: AI call failed', { job: jobTitle, jobId }, err);
    recordTailorFailure(jobId, jobTitle);
    return null;
  }

  let parsed: {
    match_score: number;
    missing_keywords: string[];
    title: string;
    summary: string;
    skills: string;
    experience: Array<{ company: string; role: string; period: string; bullets: string[] }>;
    ats_issues: string[];
    questions: string[];
  };

  try {
    parsed = JSON.parse(stripJson(raw));
  } catch {
    logger.error('resume-tailor: failed to parse AI response as JSON', {
      raw: raw.slice(0, 200), jobId, job: jobTitle,
    });
    // JSON-parse failures also waste the AI call — count them the same as
    // network failures so a job that keeps eliciting garbage from the model
    // gets blocklisted too.
    recordTailorFailure(jobId, jobTitle);
    return null;
  }

  const experience: ExperienceRole[] = (parsed.experience ?? []).map((e) => ({
    company: e.company ?? '',
    role: e.role ?? '',
    period: e.period ?? '',
    bullets: (e.bullets ?? []).map(removeSlop),
  }));

  const result: TailoredContent = {
    matchScore: parsed.match_score ?? 0,
    missingKeywords: parsed.missing_keywords ?? [],
    title: removeSlop(parsed.title ?? ''),
    summary: removeSlop(parsed.summary ?? ''),
    skills: removeSlop(parsed.skills ?? ''),
    experience,
    atsIssues: parsed.ats_issues ?? [],
    questions: parsed.questions ?? [],
    variant,
  };

  logger.info('resume-tailor: complete', {
    job: jobTitle,
    matchScore: result.matchScore,
    missingKeywords: result.missingKeywords,
    atsIssues: result.atsIssues.length,
    questions: result.questions.length,
  });

  if (result.atsIssues.length > 0) {
    logger.warn('resume-tailor: ATS issues found', { issues: result.atsIssues });
  }

  logQuestions(result.questions, { job_title: jobTitle, company, url });

  // Success — reset the failure counter for this job.
  clearTailorFailure(jobId);

  return result;
}
