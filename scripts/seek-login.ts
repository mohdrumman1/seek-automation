// Usage: npm run seek-login
// Opens Seek in a browser window. Log in manually, then press Enter in the terminal to save the session.

import { chromium } from '@playwright/test';
import * as readline from 'readline';
import { saveSession } from '../lib/seek-session';

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
  });

  const page = await context.newPage();
  await page.goto('https://www.seek.com.au/oauth/login?returnUrl=https%3A%2F%2Fwww.seek.com.au%2F', {
    waitUntil: 'domcontentloaded',
  });

  console.log('\nSeek login page is open.');
  console.log('Log in with your email and complete any OTP/2FA steps.');
  console.log('\nPress ENTER here once you are fully logged in...');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => rl.question('', () => { rl.close(); resolve(); }));

  await saveSession(context);
  await browser.close();
  console.log('Done. Run "npm run seek" to start applying.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
