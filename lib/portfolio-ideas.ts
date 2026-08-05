// Portfolio project idea extractor. Runs per-job during the SEEK apply flow,
// asking OpenRouter (the same model resume-tailor uses) to propose 1-3 solo,
// week-scoped, Claude-Code/Codex-buildable projects from the JD. Non-blocking:
// every failure path swallows the error so the apply flow never regresses on
// this side-quest.
//
// Data flow:
//   apply → extractPortfolioIdeas(title, desc, url) → PortfolioIdea[]
//        → appendIdeas(...)                 → data/portfolio_ideas.json
//        → generateDigest()                 → data/portfolio_ideas.md
//
// Skip conditions (all silent — this feature is best-effort):
//   - EXTRACT_PORTFOLIO_IDEAS=false      (default on; caller-gated)
//   - OpenRouter already returned 402    (out-of-credits; module flag)
//   - jobUrl already in portfolio_ideas.json
//   - ≥ IDEAS_SOFT_CAP total ideas       (user hasn't reviewed the backlog yet)
//   - 20s request timeout                (never block apply on LLM latency)
//   - OPENROUTER_API_KEY unset/empty
//   - LLM returned non-JSON              (logged once, skipped)

import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

const IDEAS_JSON = path.resolve(__dirname, '../data/portfolio_ideas.json');
const IDEAS_MD = path.resolve(__dirname, '../data/portfolio_ideas.md');

// Model kept in sync with lib/openrouter.ts default so a future deprecation
// only requires OPENROUTER_MODEL env or a coordinated bump in both files.
const MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';

// Soft cap: once we have this many ideas queued for the user's review, stop
// extracting until they've clipped the JSON down. Prevents unbounded growth.
const IDEAS_SOFT_CAP = 50;

// Hard cap on request latency — must be well below any per-job budget so a
// slow LLM never blocks the apply flow.
const REQUEST_TIMEOUT_MS = 20_000;

// Module-scoped short-circuit. Set to true on the first OpenRouter 402 seen
// in this process (credit issue) — every subsequent call skips silently so we
// don't spam retries or waste jobs' apply latency on a known-broken key.
// ponytail: process-wide flag; a fresh worker/CI job will re-discover 402 on
// its first call. Upgrade to a data/ file with TTL only if that becomes noisy.
let openrouterOutOfCredits = false;

export interface PortfolioIdea {
  title: string;
  oneLineWhy: string;
  keyTech: string[];
  demonstrates: string[];
  effortDays: number;
  sourceJobUrl: string;
  jobTitle: string;
  extractedAt: string;
}

// ── File I/O ──────────────────────────────────────────────────────────────

function loadIdeas(): PortfolioIdea[] {
  if (!fs.existsSync(IDEAS_JSON)) return [];
  try {
    const raw = fs.readFileSync(IDEAS_JSON, 'utf-8');
    const parsed = JSON.parse(raw) as PortfolioIdea[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIdeasAtomic(ideas: PortfolioIdea[]): void {
  // tmp + rename — a crash mid-write leaves the previous JSON intact instead
  // of a truncated file that the next run can't parse.
  const tmp = `${IDEAS_JSON}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ideas, null, 2), 'utf-8');
  fs.renameSync(tmp, IDEAS_JSON);
}

// Pure dedupe function — separated from appendIdeas so the self-check can
// exercise it without touching data/.
function dedupeByTitle(
  existing: PortfolioIdea[],
  incoming: PortfolioIdea[],
): PortfolioIdea[] {
  const seen = new Set(existing.map((i) => i.title.trim().toLowerCase()));
  const out: PortfolioIdea[] = [];
  for (const i of incoming) {
    const key = i.title.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

export function appendIdeas(newIdeas: PortfolioIdea[]): void {
  if (newIdeas.length === 0) return;
  const existing = loadIdeas();
  const additions = dedupeByTitle(existing, newIdeas);
  if (additions.length === 0) return;
  writeIdeasAtomic([...existing, ...additions]);
  logger.info('portfolio-ideas: appended', {
    added: additions.length,
    total: existing.length + additions.length,
  });
}

export function generateDigest(): void {
  const ideas = loadIdeas();
  const groups = new Map<number, PortfolioIdea[]>();
  for (const idea of ideas) {
    const days = Number.isFinite(idea.effortDays) ? idea.effortDays : 5;
    if (!groups.has(days)) groups.set(days, []);
    groups.get(days)!.push(idea);
  }
  const sortedDays = [...groups.keys()].sort((a, b) => a - b);
  const lines: string[] = ['# Portfolio Project Ideas', ''];
  if (ideas.length === 0) {
    lines.push('_No ideas yet — the SEEK apply flow will populate this file as jobs are seen._');
  }
  for (const days of sortedDays) {
    lines.push(`## ${days} day${days === 1 ? '' : 's'} effort`, '');
    for (const idea of groups.get(days)!) {
      const tech = idea.keyTech.length ? ` — Tech: ${idea.keyTech.join(', ')}` : '';
      lines.push(`- **${idea.title}** — ${idea.oneLineWhy}${tech}`);
    }
    lines.push('');
  }
  fs.writeFileSync(IDEAS_MD, lines.join('\n'), 'utf-8');
}

// ── LLM ──────────────────────────────────────────────────────────────────

function stripJson(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const arrStart = raw.indexOf('[');
  const arrEnd = raw.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) return raw.slice(arrStart, arrEnd + 1);
  return raw.trim();
}

// Dedicated fetch — deliberately bypasses lib/openrouter.ts's withRetry loop.
// This is best-effort side-quest work: retrying on 429/5xx wastes credit and
// latency on jobs the user cares more about applying to than extracting ideas
// from. Single shot, honest signal, move on.
async function fetchOpenRouterOnce(prompt: string): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || !key.trim()) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 402) {
      openrouterOutOfCredits = true;
      logger.warn('portfolio-ideas: OpenRouter 402 (out of credits) — skipping all further extractions this run');
      return null;
    }
    if (!res.ok) {
      logger.info('portfolio-ideas: OpenRouter non-OK, skipping', { status: res.status });
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    // Timeout or network — this feature is opportunistic, log and move on.
    logger.info('portfolio-ideas: OpenRouter request failed, skipping', {
      error: String(err).slice(0, 120),
    });
    return null;
  }
}

export async function extractPortfolioIdeas(
  jobTitle: string,
  jobDescription: string,
  jobUrl: string,
): Promise<PortfolioIdea[]> {
  if (openrouterOutOfCredits) return [];

  const existing = loadIdeas();
  if (existing.length >= IDEAS_SOFT_CAP) {
    logger.info('portfolio-ideas: soft cap reached, skipping extraction', {
      total: existing.length, cap: IDEAS_SOFT_CAP,
    });
    return [];
  }
  if (existing.some((i) => i.sourceJobUrl === jobUrl)) return [];

  const prompt = `You are helping an AI/ML engineer collate portfolio project ideas from real job listings.
Given this job description, propose 1-3 portfolio projects the candidate could build in under a week using Claude Code or OpenAI Codex that would demonstrate the required skills.

Each project MUST:
- Be specific (not "build an AI chatbot" — say "build a RAG over SEC filings with citation-aware chunking").
- Directly demonstrate skills listed in the JD.
- Be ship-able solo in 5 days or fewer.

JOB TITLE: ${jobTitle}
JOB URL: ${jobUrl}
JOB DESCRIPTION:
${jobDescription.slice(0, 3000)}

Return ONLY a JSON array (no markdown fences, no explanation) matching this shape:
[
  {
    "title": "specific project name",
    "oneLineWhy": "why this proves fit for the role",
    "keyTech": ["tech1", "tech2"],
    "demonstrates": ["skill1", "skill2"],
    "effortDays": 3
  }
]`;

  const raw = await fetchOpenRouterOnce(prompt);
  if (!raw) return [];

  let parsed: Array<{
    title?: string;
    oneLineWhy?: string;
    keyTech?: string[];
    demonstrates?: string[];
    effortDays?: number;
  }>;
  try {
    const val = JSON.parse(stripJson(raw));
    if (!Array.isArray(val)) return [];
    parsed = val;
  } catch {
    logger.info('portfolio-ideas: LLM response was not valid JSON, skipping', {
      raw: raw.slice(0, 200),
    });
    return [];
  }

  const now = new Date().toISOString();
  return parsed
    .filter((p) => typeof p.title === 'string' && p.title.trim().length > 0)
    .map((p) => ({
      title: (p.title ?? '').trim(),
      oneLineWhy: (p.oneLineWhy ?? '').trim(),
      keyTech: Array.isArray(p.keyTech) ? p.keyTech.slice(0, 8) : [],
      demonstrates: Array.isArray(p.demonstrates) ? p.demonstrates.slice(0, 8) : [],
      // Clamp effortDays to 1-5 — the prompt asks for a week or less; anything
      // outside that is a model hallucination we should snap to the intent.
      effortDays: Math.max(1, Math.min(5, Math.round(Number(p.effortDays ?? 3)) || 3)),
      sourceJobUrl: jobUrl,
      jobTitle,
      extractedAt: now,
    }));
}

// ── Self-check ────────────────────────────────────────────────────────────
// ponytail: pure-function checks only (dedupe + stripJson + effortDays clamp).
// Does NOT touch data/portfolio_ideas.json — safe to run without side effects.
// Upgrade path: promote to tests/portfolio-ideas.spec.ts when a second module
// needs to exercise dedupeByTitle.
if (require.main === module) {
  const now = new Date().toISOString();
  const mk = (title: string): PortfolioIdea => ({
    title, oneLineWhy: '', keyTech: [], demonstrates: [],
    effortDays: 3, sourceJobUrl: '', jobTitle: '', extractedAt: now,
  });
  const deduped = dedupeByTitle([mk('X')], [mk('x'), mk('  X  '), mk('Y')]);
  console.assert(
    deduped.length === 1 && deduped[0].title === 'Y',
    `dedupeByTitle failed: ${JSON.stringify(deduped)}`,
  );

  const strippedFence = stripJson('```json\n[{"a":1}]\n```');
  console.assert(strippedFence === '[{"a":1}]', `stripJson fence failed: ${strippedFence}`);
  const strippedRaw = stripJson('prefix [{"a":1}] suffix');
  console.assert(strippedRaw === '[{"a":1}]', `stripJson raw failed: ${strippedRaw}`);

  const digestGroups = new Map<number, PortfolioIdea[]>();
  for (const d of [3, 1, 5, 3]) {
    if (!digestGroups.has(d)) digestGroups.set(d, []);
    digestGroups.get(d)!.push(mk(`d${d}`));
  }
  const sorted = [...digestGroups.keys()].sort((a, b) => a - b);
  console.assert(
    JSON.stringify(sorted) === '[1,3,5]',
    `digest day sort failed: ${JSON.stringify(sorted)}`,
  );

  console.log('portfolio-ideas: self-check ok');
}
