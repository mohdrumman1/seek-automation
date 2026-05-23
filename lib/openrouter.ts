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

export async function tailorCoverLetter(
  base: string,
  title: string,
  company: string,
  description: string
): Promise<string> {
  const prompt =
    `Tailor this cover letter for a ${title} role at ${company}.\n\n` +
    `Job Description:\n${description.slice(0, 1500)}\n\n` +
    `Base Cover Letter:\n${base}\n\n` +
    `Rules:\n` +
    `- Keep the same tone and structure\n` +
    `- Personalise the company name and role-specific details\n` +
    `- Keep it under 350 words\n` +
    `- Return only the cover letter text, nothing else`;
  try {
    return await callOpenRouter(prompt);
  } catch (e) {
    console.error(`  AI tailoring failed (${e}) - using base cover letter`);
    return base;
  }
}
