import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The lib/openrouter module resolves MODEL / VISION_MODEL at import time,
// so each test must clear its module cache, set env, then dynamic-import.
// Fetch is stubbed to capture the request body without hitting the network.

type CapturedRequest = { url: string; body: any } | null;

function stubFetch(): { captured: () => CapturedRequest; restore: () => void } {
  let last: CapturedRequest = null;
  const originalFetch = global.fetch;
  const fake = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    last = { url: String(url), body };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  // @ts-expect-error — assigning a mock fetch is fine for the test
  global.fetch = fake;
  return {
    captured: () => last,
    restore: () => {
      global.fetch = originalFetch;
    },
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Always have an API key so the module-level guard doesn't throw.
  process.env.OPENROUTER_API_KEY = 'test-key';
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_VISION_MODEL;
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('openrouter model selection', () => {
  it('defaults to google/gemini-2.5-flash when OPENROUTER_MODEL is unset', async () => {
    const f = stubFetch();
    const { callOpenRouter } = await import('../../lib/openrouter');
    await callOpenRouter('hello');
    expect(f.captured()?.body.model).toBe('google/gemini-2.5-flash');
    f.restore();
  });

  it('defaults to google/gemini-2.5-flash when OPENROUTER_MODEL is an empty string', async () => {
    process.env.OPENROUTER_MODEL = '';
    const f = stubFetch();
    const { callOpenRouter } = await import('../../lib/openrouter');
    await callOpenRouter('hello');
    expect(f.captured()?.body.model).toBe('google/gemini-2.5-flash');
    f.restore();
  });

  it('uses OPENROUTER_MODEL when it is set to a non-empty value', async () => {
    process.env.OPENROUTER_MODEL = 'anthropic/claude-3.5-sonnet';
    const f = stubFetch();
    const { callOpenRouter } = await import('../../lib/openrouter');
    await callOpenRouter('hello');
    expect(f.captured()?.body.model).toBe('anthropic/claude-3.5-sonnet');
    f.restore();
  });

  it('vision defaults to the same model as chat (google/gemini-2.5-flash) when nothing is set', async () => {
    const f = stubFetch();
    const { callOpenRouterVision } = await import('../../lib/openrouter');
    await callOpenRouterVision('describe', 'aGVsbG8=');
    expect(f.captured()?.body.model).toBe('google/gemini-2.5-flash');
    f.restore();
  });

  it('setting only OPENROUTER_MODEL also cascades into the vision call', async () => {
    process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini';
    const f = stubFetch();
    const { callOpenRouterVision } = await import('../../lib/openrouter');
    await callOpenRouterVision('describe', 'aGVsbG8=');
    expect(f.captured()?.body.model).toBe('openai/gpt-4o-mini');
    f.restore();
  });

  it('OPENROUTER_VISION_MODEL wins over OPENROUTER_MODEL for the vision call', async () => {
    process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini';
    process.env.OPENROUTER_VISION_MODEL = 'google/gemini-2.5-pro';
    const f = stubFetch();
    const { callOpenRouterVision, callOpenRouter } = await import('../../lib/openrouter');
    await callOpenRouterVision('describe', 'aGVsbG8=');
    expect(f.captured()?.body.model).toBe('google/gemini-2.5-pro');

    // …and the chat call still uses OPENROUTER_MODEL, not the vision override.
    await callOpenRouter('hello');
    expect(f.captured()?.body.model).toBe('openai/gpt-4o-mini');
    f.restore();
  });

  it('OPENROUTER_VISION_MODEL empty string falls back to MODEL', async () => {
    process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini';
    process.env.OPENROUTER_VISION_MODEL = '';
    const f = stubFetch();
    const { callOpenRouterVision } = await import('../../lib/openrouter');
    await callOpenRouterVision('describe', 'aGVsbG8=');
    expect(f.captured()?.body.model).toBe('openai/gpt-4o-mini');
    f.restore();
  });
});
