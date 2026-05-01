import * as fs from 'fs';
import * as path from 'path';
import { Browser, BrowserContext } from '@playwright/test';

const STORAGE_STATE_PATH = path.resolve(__dirname, '../data/seek-session.json');

export async function getOrCreateSession(browser: Browser): Promise<BrowserContext> {
  const hasSession = fs.existsSync(STORAGE_STATE_PATH);
  const context = await browser.newContext({
    storageState: hasSession ? STORAGE_STATE_PATH : undefined,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
  });
  if (hasSession) {
    console.log('Loaded saved session from seek-session.json');
  }
  return context;
}

export async function saveSession(context: BrowserContext): Promise<void> {
  await context.storageState({ path: STORAGE_STATE_PATH });
  console.log('Session saved to seek-session.json');
}
