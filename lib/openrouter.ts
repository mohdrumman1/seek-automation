import { logger } from './logger';

if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY.trim() === '') {
  throw new Error('Missing OPENROUTER_API_KEY. Add it to .env locally or GitHub Actions secrets.');
}
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = 'google/gemini-2.0-flash-001';

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxRetries = 3;
  const baseMs = 500;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message ?? '';
      const statusMatch = msg.match(/OpenRouter(?:\s+vision)?\s+(\d{3})/i);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      const emptyContent = msg.includes('returned empty content');
      const retryable = status === 429 || status >= 500 || status === 0 || emptyContent;
      if (!retryable || attempt === maxRetries) throw err;
      const delayMs = Math.min(baseMs * 2 ** attempt, 8000) + Math.random() * 250;
      logger.warn('openrouter retry', { label, attempt: attempt + 1, status: status || 'network', delayMs: Math.round(delayMs) });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export async function callOpenRouter(prompt: string): Promise<string> {
  const inner = async () => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`OpenRouter returned empty content: ${JSON.stringify(data).slice(0, 200)}`);
    return content.trim();
  };
  return withRetry(inner, 'chat');
}

export async function callOpenRouterVision(prompt: string, imageBase64: string): Promise<string> {
  const inner = async () => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
            ],
          },
        ],
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`OpenRouter vision ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`OpenRouter vision returned empty content: ${JSON.stringify(data).slice(0, 200)}`);
    return content.trim();
  };
  return withRetry(inner, 'vision');
}

function applyFallbackSubstitutions(text: string, title: string, company: string): string {
  return text
    .replace(/\[ROLE\]/g, title)
    .replace(/\[COMPANY\]/g, company);
}

function validateTailoredLetter(text: string, title: string, company: string): boolean {
  // Must have replaced both placeholders and must not still reference KazGard
  const hasUnreplacedRole = text.includes('[ROLE]');
  const hasUnreplacedCompany = text.includes('[COMPANY]');
  const hasWrongCompany = /kazgard/i.test(text) && !/kazgard/i.test(company);
  return !hasUnreplacedRole && !hasUnreplacedCompany && !hasWrongCompany;
}

export async function tailorCoverLetter(
  base: string,
  title: string,
  company: string,
  description: string
): Promise<string> {
  const prompt =
    `You are tailoring a cover letter template for a specific job application.\n\n` +
    `TARGET ROLE: ${title}\n` +
    `TARGET COMPANY: ${company}\n\n` +
    `Job Description:\n${description.slice(0, 1500)}\n\n` +
    `Cover Letter Template (contains [ROLE] and [COMPANY] placeholders):\n${base}\n\n` +
    `Rules:\n` +
    `- Replace [ROLE] with exactly: ${title}\n` +
    `- Replace [COMPANY] with exactly: ${company}\n` +
    `- Update role-specific details in the body to match the job description\n` +
    `- Do NOT mention any other company name — this letter must be for ${company} only\n` +
    `- Keep the same tone and structure\n` +
    `- Keep it under 350 words\n` +
    `- Return only the final cover letter text, nothing else`;
  try {
    const tailored = await callOpenRouter(prompt);
    if (!validateTailoredLetter(tailored, title, company)) {
      logger.warn('tailorCoverLetter: output failed validation — applying fallback substitutions', {
        title,
        company,
        snippet: tailored.slice(0, 100),
      });
      return applyFallbackSubstitutions(tailored, title, company);
    }
    return tailored;
  } catch (e) {
    console.error(`  AI tailoring failed (${e}) - applying substitutions to base cover letter`);
    logger.warn('tailorCoverLetter: AI call failed — applying substitutions to base', {
      title,
      company,
      error: String(e),
    });
    return applyFallbackSubstitutions(base, title, company);
  }
}
