import * as fs from 'fs';
import * as path from 'path';
import { Page } from '@playwright/test';
import { callOpenRouterVision } from './openrouter';

const ERROR_LOG_PATH = path.resolve(__dirname, '../data/error-log.json');
const SCREENSHOT_DIR = path.resolve(__dirname, '../screenshots/errors');

export interface ErrorEntry {
  timestamp: string;
  error_type: string;
  job_title?: string;
  company?: string;
  url: string;
  page_title: string;
  screenshot: string;
  analysis: string;
}

export function loadErrorLog(): ErrorEntry[] {
  if (!fs.existsSync(ERROR_LOG_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(ERROR_LOG_PATH, 'utf-8')) as ErrorEntry[];
  } catch {
    return [];
  }
}

function saveErrorLog(log: ErrorEntry[]): void {
  fs.writeFileSync(ERROR_LOG_PATH, JSON.stringify(log, null, 2), 'utf-8');
}

// Returns the AI analyses from the last N occurrences of a given error type
export function getPastAnalyses(errorType: string, limit = 3): string[] {
  return loadErrorLog()
    .filter((e) => e.error_type === errorType)
    .slice(-limit)
    .map((e) => e.analysis)
    .filter(Boolean);
}

export async function captureAndAnalyze(
  page: Page,
  errorType: string,
  context?: { job_title?: string; company?: string }
): Promise<string> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotPath = path.join(SCREENSHOT_DIR, `${ts}_${errorType}.png`);

  let imageBase64 = '';
  try {
    const buffer = await page.screenshot({ path: screenshotPath, fullPage: false });
    imageBase64 = buffer.toString('base64');
    console.log(`  [Analyzer] Screenshot saved: ${path.basename(screenshotPath)}`);
  } catch {
    console.log(`  [Analyzer] Screenshot failed for ${errorType}`);
    return '';
  }

  const pageTitle = await page.title().catch(() => '');
  const url = page.url();

  const past = getPastAnalyses(errorType);
  const pastSection = past.length
    ? `\nPrevious analyses for this same error:\n${past.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
    : '';

  const prompt =
    `You are diagnosing a browser automation error on Seek.com.au.\n\n` +
    `Error type: ${errorType}\n` +
    `Page title: ${pageTitle}\n` +
    `URL: ${url}\n` +
    `Job: ${context?.job_title ?? 'unknown'} @ ${context?.company ?? 'unknown'}` +
    pastSection +
    `\n\nLook at this screenshot and answer:\n` +
    `1. What is visible on screen right now?\n` +
    `2. What caused this error?\n` +
    `3. What specific CSS selector or action should the bot try next time to fix it?\n\n` +
    `Be concise. No more than 4 sentences.`;

  let analysis = '';
  try {
    analysis = await callOpenRouterVision(prompt, imageBase64);
    console.log(`  [Analyzer] ${errorType}: ${analysis.slice(0, 150)}${analysis.length > 150 ? '...' : ''}`);
  } catch (e) {
    console.log(`  [Analyzer] AI call failed: ${(e as Error).message}`);
    analysis = 'AI analysis unavailable';
  }

  const entry: ErrorEntry = {
    timestamp: new Date().toISOString(),
    error_type: errorType,
    job_title: context?.job_title,
    company: context?.company,
    url,
    page_title: pageTitle,
    screenshot: screenshotPath,
    analysis,
  };

  const log = loadErrorLog();
  log.push(entry);
  saveErrorLog(log);

  return analysis;
}
