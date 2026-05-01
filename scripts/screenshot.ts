// Usage: npm run screenshot -- <url> [output-path]
// Examples:
//   npm run screenshot -- https://seek.com.au
//   npm run screenshot -- https://seek.com.au screenshots/seek.png
//   npx playwright screenshot https://seek.com.au seek.png --full-page

import { chromium } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

async function main() {
  const url = process.argv[2];
  const outArg = process.argv[3];

  if (!url) {
    console.error('Usage: npm run screenshot -- <url> [output-path]');
    process.exit(1);
  }

  const outputDir = path.resolve(__dirname, '../screenshots');
  fs.mkdirSync(outputDir, { recursive: true });

  let hostname = 'screenshot';
  try {
    hostname = new URL(url).hostname.replace(/\./g, '-');
  } catch {
    // keep default
  }

  const filename = outArg
    ? path.resolve(outArg)
    : path.join(outputDir, `${hostname}_${Date.now()}.png`);

  console.log(`Capturing ${url} ...`);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.screenshot({ path: filename, fullPage: true });
    console.log(`Screenshot saved: ${filename}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
