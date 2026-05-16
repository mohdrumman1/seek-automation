import * as fs from 'fs';
import * as path from 'path';
import { Browser, BrowserContext, Page } from '@playwright/test';
import { logger } from './logger';

const SESSIONS_DIR = path.resolve(__dirname, '../data/sessions');
const FULL_SESSION_PATH = path.join(SESSIONS_DIR, 'seek-session.json');
const SLIM_SESSION_PATH = path.join(SESSIONS_DIR, 'seek-cookies.json');
const LEGACY_SESSION_PATH = path.resolve(__dirname, '../data/seek-session.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1366, height: 768 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StorageState = {
  cookies: Array<any>;
  origins: Array<any>;
};

function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function decodeEnvSession(): StorageState | null {
  const raw = process.env.SEEK_SESSION_COOKIES;
  if (!raw || raw.trim() === '') return null;
  try {
    const json = Buffer.from(raw.trim(), 'base64').toString('utf8');
    const parsed = JSON.parse(json) as StorageState;
    if (!parsed || !Array.isArray(parsed.cookies)) {
      logger.warn('SEEK_SESSION_COOKIES decoded but missing cookies array');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.error('failed to decode SEEK_SESSION_COOKIES', {}, err);
    return null;
  }
}

function isSeekCookie(c: Record<string, unknown>): boolean {
  const domain = (c.domain as string | undefined) ?? '';
  return domain.includes('seek.com.au') || domain.includes('seek.com');
}

function slimDown(state: StorageState): StorageState {
  return {
    cookies: state.cookies.filter(isSeekCookie),
    origins: [],
  };
}

export async function getOrCreateSession(browser: Browser): Promise<BrowserContext> {
  ensureSessionsDir();

  const envSession = decodeEnvSession();
  if (envSession) {
    logger.info('seek session: loaded from SEEK_SESSION_COOKIES env var', {
      cookieCount: envSession.cookies.length,
    });
    return browser.newContext({
      storageState: envSession,
      userAgent: UA,
      viewport: VIEWPORT,
    });
  }

  if (fs.existsSync(FULL_SESSION_PATH)) {
    logger.info('seek session: loaded from data/sessions/seek-session.json');
    return browser.newContext({
      storageState: FULL_SESSION_PATH,
      userAgent: UA,
      viewport: VIEWPORT,
    });
  }

  if (fs.existsSync(LEGACY_SESSION_PATH)) {
    logger.warn('seek session: loaded from legacy data/seek-session.json — will migrate on next saveSession');
    return browser.newContext({
      storageState: LEGACY_SESSION_PATH,
      userAgent: UA,
      viewport: VIEWPORT,
    });
  }

  logger.info('seek session: no saved session — creating fresh context');
  return browser.newContext({
    userAgent: UA,
    viewport: VIEWPORT,
  });
}

export async function saveSession(context: BrowserContext): Promise<void> {
  ensureSessionsDir();

  const full = (await context.storageState()) as StorageState;
  fs.writeFileSync(FULL_SESSION_PATH, JSON.stringify(full, null, 2));

  const slim = slimDown(full);
  fs.writeFileSync(SLIM_SESSION_PATH, JSON.stringify(slim));

  const slimB64 = Buffer.from(JSON.stringify(slim), 'utf8').toString('base64');
  const sizeKb = Math.round((slimB64.length / 1024) * 10) / 10;

  logger.info('seek session saved', {
    fullPath: FULL_SESSION_PATH,
    slimPath: SLIM_SESSION_PATH,
    seekCookies: slim.cookies.length,
    slimBase64Kb: sizeKb,
  });

  process.stdout.write(`[SESSION_COOKIES_B64] ${slimB64}\n`);
}

export async function isSessionExpired(page: Page): Promise<boolean> {
  try {
    await page.goto('https://www.seek.com.au', { waitUntil: 'domcontentloaded', timeout: 20_000 });
  } catch (err) {
    logger.error('isSessionExpired: navigation failed — assuming expired', {}, err);
    return true;
  }

  const signInSelectors = [
    '[data-automation="sign in"]',
    'a[href*="/oauth/login"]',
    'a:has-text("Sign in")',
    'button:has-text("Sign in")',
  ];

  for (const sel of signInSelectors) {
    const visible = await page.locator(sel).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  return false;
}
