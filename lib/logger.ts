// Structured JSON-line logger. One line per event, easy to grep in GitHub
// Actions log output and trivial to pipe through jq locally.
//
// Usage:
//   import { logger } from '../lib/logger';
//   logger.info('applied', { jobId, company });
//   logger.error('apply failed', { jobId }, err);

export function redactPII(value: string): string {
  return value
    .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    .replace(/\b\d{3}\s?\d{3}\s?\d{3}\b/g, '[REDACTED_TFN]')
    .replace(/(?:\+61|0)[0-9\s().\-]{8,}[0-9]/g, '[REDACTED_PHONE]');
}

export function sanitise(obj: unknown, depth = 0): unknown {
  if (depth > 6) return obj;
  if (typeof obj === 'string') return redactPII(obj);
  if (Array.isArray(obj)) return obj.map((v) => sanitise(v, depth + 1));
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, sanitise(v, depth + 1)])
    );
  }
  return obj;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveThreshold(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return LEVELS[raw] ?? LEVELS.info;
}

const THRESHOLD = resolveThreshold();

function emit(level: Level, msg: string, data?: Record<string, unknown>, err?: unknown): void {
  if (LEVELS[level] < THRESHOLD) return;

  msg = redactPII(msg);
  if (data) data = sanitise(data) as Record<string, unknown>;

  const line: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    msg,
  };
  if (data && Object.keys(data).length > 0) line.data = data;

  if (err !== undefined) {
    if (err instanceof Error) {
      line.error = {
        name: err.name,
        message: redactPII(err.message),
        stack: err.stack,
      };
    } else {
      line.error = { value: String(err) };
    }
  }

  const out = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  try {
    out.write(JSON.stringify(line) + '\n');
  } catch {
    out.write(`{"level":"${level}","ts":"${new Date().toISOString()}","msg":${JSON.stringify(msg)},"note":"log_serialize_failed"}\n`);
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>, err?: unknown) =>
    emit('error', msg, data, err),
};

export const log = logger;
