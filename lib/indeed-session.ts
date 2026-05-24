import * as fs from 'fs';
import * as path from 'path';
import { Browser, BrowserContext, Page } from '@playwright/test';
import { logger } from './logger';

const SESSIONS_DIR = path.resolve(__dirname, '../data/sessions');
const SESSION_PATH = path.join(SESSIONS_DIR, 'indeed-session.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1366, height: 768 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StorageState = { cookies: Array<any>; origins: Array<any> };

function ensureDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function decodeEnvSession(): StorageState | null {
  const raw = process.env.INDEED_SESSION_COOKIES;
  if (!raw || raw.trim() === '') return null;
  try {
    const json = Buffer.from(raw.trim(), 'base64').toString('utf8');
    const parsed = JSON.parse(json) as StorageState;
    if (!parsed || !Array.isArray(parsed.cookies)) {
      logger.warn('INDEED_SESSION_COOKIES decoded but missing cookies array');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.error('failed to decode INDEED_SESSION_COOKIES', {}, err);
    return null;
  }
}

export async function getOrCreateIndeedSession(browser: Browser): Promise<BrowserContext> {
  ensureDir();

  const envSession = decodeEnvSession();
  if (envSession) {
    logger.info('indeed session: loaded from INDEED_SESSION_COOKIES env var', {
      cookieCount: envSession.cookies.length,
    });
    return browser.newContext({ storageState: envSession, userAgent: UA, viewport: VIEWPORT });
  }

  if (fs.existsSync(SESSION_PATH)) {
    logger.info('indeed session: loaded from disk', { path: SESSION_PATH });
    return browser.newContext({ storageState: SESSION_PATH, userAgent: UA, viewport: VIEWPORT });
  }

  logger.info('indeed session: no saved session — creating fresh context (will need manual login)');
  return browser.newContext({ userAgent: UA, viewport: VIEWPORT });
}

export async function saveIndeedSession(context: BrowserContext): Promise<void> {
  ensureDir();
  const state = await context.storageState();
  fs.writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2));
  logger.info('indeed session saved', { path: SESSION_PATH, cookies: state.cookies.length });
}

export async function isIndeedSessionExpired(page: Page): Promise<boolean> {
  try {
    await page.goto('https://myjobs.indeed.com/', { waitUntil: 'load', timeout: 30_000 });
  } catch (err) {
    logger.error('isIndeedSessionExpired: navigation failed — assuming expired', {}, err);
    return true;
  }

  const url = page.url();
  if (url.includes('secure.indeed.com/auth') || url.includes('/account/login') || url.includes('/login')) {
    logger.info('indeed session expired: redirected to auth', { url });
    return true;
  }

  await page.waitForTimeout(2_000);
  const signInVisible = await page
    .locator('a:has-text("Sign in"), button:has-text("Sign in"), [data-tn="header-signin-link"]')
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);

  if (signInVisible) {
    logger.info('indeed session expired: sign-in element visible');
    return true;
  }

  return false;
}
