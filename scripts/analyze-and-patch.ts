// Runs after seek-apply to patch the KB from the review queue.
// Called by: npm run analyze
// Reads data/review-queue.json, generates AI answers for unresolved questions,
// saves them to data/questions_kb.json, then marks entries resolved.

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { loadKB, saveKB } from '../lib/questions-kb';
import { callOpenRouter } from '../lib/openrouter';

const REVIEW_QUEUE_PATH = path.resolve(__dirname, '../data/review-queue.json');
const ERROR_LOG_PATH = path.resolve(__dirname, '../data/error-log.json');

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
`;

interface ReviewEntry {
  timestamp: string;
  job_title?: string;
  company?: string;
  url: string;
  unanswered: { label: string; type: string; options?: string[] }[];
  resolved: boolean;
}

async function main() {
  console.log('=== Maintenance: Analyze & Patch ===');

  if (!fs.existsSync(REVIEW_QUEUE_PATH)) {
    console.log('No review queue found - nothing to patch.');
    return;
  }

  const queue = JSON.parse(fs.readFileSync(REVIEW_QUEUE_PATH, 'utf-8')) as ReviewEntry[];
  const unresolved = queue.filter((e) => !e.resolved);
  console.log(`Review queue: ${queue.length} total, ${unresolved.length} unresolved`);

  if (unresolved.length === 0) {
    console.log('All entries resolved - nothing to patch.');
    return;
  }

  const kb = loadKB();
  let patched = 0;

  for (const entry of unresolved) {
    console.log(`\nPatching: ${entry.job_title ?? 'unknown'} @ ${entry.company ?? 'unknown'}`);
    let allAnswered = true;

    for (const q of entry.unanswered) {
      const optionsList = q.options?.filter((o) => o.trim()).join(' | ') ?? '';
      const prompt =
        `You are completing a job application form for this candidate:\n${CANDIDATE_PROFILE}\n\n` +
        `Question: "${q.label}"\n` +
        (optionsList ? `Available options: ${optionsList}\n` : '') +
        `Return ONLY the exact answer text. For Yes/No return "Yes" or "No". No explanation.`;

      const answer = await callOpenRouter(prompt).catch(() => '');
      if (answer.trim()) {
        const keywords = q.label.toLowerCase().split(/\W+/).filter((w) => w.length > 3).slice(0, 6);
        kb.push({ keywords, answer: answer.trim() });
        console.log(`  KB patched: "${q.label.slice(0, 55)}" → "${answer.trim().slice(0, 40)}"`);
        patched++;
      } else {
        allAnswered = false;
        console.log(`  Could not generate answer for: "${q.label.slice(0, 55)}"`);
      }
    }

    entry.resolved = allAnswered;
  }

  saveKB(kb);
  fs.writeFileSync(REVIEW_QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf-8');

  // Summarise recent errors
  if (fs.existsSync(ERROR_LOG_PATH)) {
    const errors = JSON.parse(fs.readFileSync(ERROR_LOG_PATH, 'utf-8')) as { error_type: string; timestamp: string }[];
    const recent = errors.filter((e) => Date.now() - new Date(e.timestamp).getTime() < 24 * 60 * 60 * 1000);
    if (recent.length > 0) {
      const counts: Record<string, number> = {};
      for (const e of recent) counts[e.error_type] = (counts[e.error_type] ?? 0) + 1;
      console.log('\nErrors in last 24h:', JSON.stringify(counts));
    }
  }

  // Surface unknown-ATS hostnames from recent skipped jobs so patterns can be added to detect.ts.
  const SKIPPED_CSV = path.resolve(__dirname, '../data/skipped_jobs.csv');
  if (fs.existsSync(SKIPPED_CSV)) {
    const lines = fs.readFileSync(SKIPPED_CSV, 'utf-8').trim().split('\n');
    const headers = lines[0].split(',');
    const extIdx = headers.indexOf('external_url');
    const reasonIdx = headers.indexOf('skip_reason');
    if (extIdx >= 0 && reasonIdx >= 0) {
      // Look at last 500 rows (recent runs).
      const recent = lines.slice(Math.max(1, lines.length - 500));
      const unknownHosts = new Map<string, number>();
      for (const line of recent) {
        const cols = line.split(',');
        if (cols[reasonIdx]?.trim() !== 'ats_unknown_provider') continue;
        const rawUrl = cols[extIdx]?.replace(/^"|"$/g, '').trim();
        if (!rawUrl) continue;
        try {
          const host = new URL(rawUrl).hostname;
          unknownHosts.set(host, (unknownHosts.get(host) ?? 0) + 1);
        } catch { /* ignore malformed URLs */ }
      }
      if (unknownHosts.size > 0) {
        console.log('\nUnknown ATS hostnames (add to lib/ats/detect.ts):');
        for (const [host, count] of [...unknownHosts.entries()].sort((a, b) => b[1] - a[1])) {
          console.log(`  ${count}x  ${host}`);
        }
      }
    }
  }

  console.log(`\n=== Done. KB patched with ${patched} new answer(s). ===`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
