import * as fs from 'fs';
import * as path from 'path';
import { callOpenRouter } from './openrouter';

const KB_PATH = path.resolve(__dirname, '../data/questions_kb.json');

interface KBEntry {
  keywords: string[];
  answer: string;
}

export function loadKB(): KBEntry[] {
  if (fs.existsSync(KB_PATH)) {
    return JSON.parse(fs.readFileSync(KB_PATH, 'utf-8')) as KBEntry[];
  }
  return [];
}

export function saveKB(kb: KBEntry[]): void {
  fs.writeFileSync(KB_PATH, JSON.stringify(kb, null, 2), 'utf-8');
}

export function findKBAnswer(question: string, kb: KBEntry[]): string | null {
  const q = question.toLowerCase();
  let bestScore = 0;
  let bestAnswer: string | null = null;
  for (const entry of kb) {
    const score = entry.keywords.filter((kw) => q.includes(kw.toLowerCase())).length;
    if (score > bestScore) {
      bestScore = score;
      bestAnswer = entry.answer;
    }
  }
  return bestScore > 0 ? bestAnswer : null;
}

export async function aiAnswerQuestion(
  question: string,
  options: string[] | null,
  kb: KBEntry[],
  candidateProfile: string
): Promise<string | null> {
  const optionsStr = options?.length
    ? options.map((o) => `- ${o}`).join('\n')
    : 'Free text response';
  const prompt =
    `Answer this job application pre-screening question for the candidate below.\n\n` +
    `CANDIDATE:\n${candidateProfile}\n\n` +
    `QUESTION: ${question}\n\n` +
    `OPTIONS:\n${optionsStr}\n\n` +
    `Rules:\n` +
    `- If options are listed: return ONLY the exact text of the best matching option\n` +
    `- If free text: write a concise, honest answer (max 80 words)\n` +
    `- Do not fabricate experience\n` +
    `- Return only the answer, nothing else`;
  try {
    const answer = await callOpenRouter(prompt);
    const words = question
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3)
      .slice(0, 6);
    kb.push({ keywords: words, answer });
    saveKB(kb);
    console.log(`  [KB] Auto-saved: '${question.slice(0, 55)}' -> '${answer.slice(0, 40)}'`);
    return answer;
  } catch (e) {
    console.error(`  AI question answering failed (${e})`);
    return null;
  }
}

export async function aiAnswerCheckboxes(
  question: string,
  options: string[],
  candidateProfile: string,
): Promise<string[]> {
  const optionsStr = options.map((o) => `- ${o}`).join('\n');
  const prompt =
    `Answer this multi-select job application question for the candidate below.\n\n` +
    `CANDIDATE:\n${candidateProfile}\n\n` +
    `QUESTION (select ALL that apply): ${question}\n\n` +
    `OPTIONS:\n${optionsStr}\n\n` +
    `Rules:\n` +
    `- Return ONLY the exact text of every option the candidate genuinely matches\n` +
    `- Separate multiple selections with a comma\n` +
    `- Do not fabricate experience; if none apply, return an empty response\n` +
    `- Return only the comma-separated option texts, nothing else`;
  try {
    const raw = await callOpenRouter(prompt);
    return raw
      .split(/[,\n]/)
      .map((s) => s.replace(/^[-•\s]+/, '').trim())
      .filter(Boolean);
  } catch (e) {
    console.error(`  AI checkbox answering failed (${e})`);
    return [];
  }
}

export function selectBestOption(options: string[], answer: string): string {
  // Normalize: collapse non-breaking spaces and trim
  const norm = (s: string) => s.replace(/\xa0/g, ' ').toLowerCase().trim();
  const a = norm(answer);

  // Exact match (tolerates \xa0 in option labels)
  for (const opt of options) {
    if (norm(opt) === a) return opt;
  }
  // Contains match
  for (const opt of options) {
    const o = norm(opt);
    if (a.includes(o) || o.includes(a)) return opt;
  }
  // Numeric proximity (e.g. salary ranges like "$120,000 - $130,000").
  // Strip commas before parsing so "120,000" parses as 120000, not 120.
  const answerNums = answer.replace(/,/g, '').match(/\d+/);
  if (answerNums) {
    const target = parseInt(answerNums[0], 10);
    let bestOpt = options[1] ?? options[0];
    let bestDiff = Infinity;
    for (const opt of options.slice(1)) {
      const nums = opt.replace(/,/g, '').match(/\d+/);
      if (nums) {
        const diff = Math.abs(parseInt(nums[0], 10) - target);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestOpt = opt;
        }
      }
    }
    return bestOpt;
  }
  // Fall back to first non-placeholder option
  return options[1] ?? options[0];
}
