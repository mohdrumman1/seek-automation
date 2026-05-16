import { Page } from '@playwright/test';
import { logger } from './logger';

export type ResumeVariant = 'pm' | 'se';

const PM_TITLE_PATTERNS = [
  /\bproject manager\b/i,
  /\btechnical (project )?(pm|manager)\b/i,
  /\bdelivery (manager|lead)\b/i,
  /\bprogram manager\b/i,
  /\bproject coordinator\b/i,
];

const SE_TITLE_PATTERNS = [
  /\bsoftware engineer\b/i,
  /\bsenior software engineer\b/i,
  /\bfull[\s-]?stack\b/i,
  /\bbackend (developer|engineer)\b/i,
  /\bfrontend (developer|engineer)\b/i,
  /\bcloud engineer\b/i,
  /\bdevops engineer\b/i,
  /\bweb developer\b/i,
];

const PM_HINTS = /delivery|stakeholder|programme?|coordination|governance|roadmap/i;
const SE_HINTS = /code|build|architecture|backend|frontend|infrastructure|api|platform|engineer/i;

export function resolveResumeVariant(jobTitle: string, searchName: string): ResumeVariant {
  const title = jobTitle ?? '';
  const ctx = `${title} ${searchName}`;

  if (PM_TITLE_PATTERNS.some((r) => r.test(title))) return 'pm';
  if (SE_TITLE_PATTERNS.some((r) => r.test(title))) return 'se';

  if (/ai integration consultant|automation consultant|integration specialist/i.test(title)) {
    if (PM_HINTS.test(ctx)) return 'pm';
    if (SE_HINTS.test(ctx)) return 'se';
  }

  if (PM_TITLE_PATTERNS.some((r) => r.test(searchName))) return 'pm';
  if (SE_TITLE_PATTERNS.some((r) => r.test(searchName))) return 'se';

  return 'se';
}

const KEYWORDS: Record<ResumeVariant, string[]> = {
  pm: ['project', 'manager', 'pm', 'delivery', 'program', 'coordinator'],
  se: ['software', 'engineer', 'developer', 'fullstack', 'backend', 'cloud', 'technical', 'engineering', 'stack'],
};

export async function selectResume(page: Page, variant: ResumeVariant): Promise<void> {
  const changeRadio = page.locator('input[name="resume-method"][value="change"]');
  if (await changeRadio.isVisible().catch(() => false)) {
    await changeRadio.click();
    await page.waitForTimeout(500);
    logger.debug('resume mode: change selected');
  }

  const dropdown = page.locator('select').first();
  const dropdownReady = await dropdown.waitFor({ timeout: 8_000 }).then(() => true).catch(() => false);
  if (!dropdownReady) {
    logger.warn('resume dropdown not found', { variant });
    return;
  }

  const options = await dropdown.locator('option').allTextContents();
  if (options.length === 0) {
    logger.warn('resume dropdown has no options', { variant });
    return;
  }

  const keywords = KEYWORDS[variant];
  let bestIdx = options.length > 1 ? 1 : 0;
  let bestScore = 0;

  options.forEach((text, i) => {
    const lower = text.toLowerCase();
    let score = 0;
    for (const k of keywords) {
      if (lower.includes(k)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });

  if (bestScore === 0) {
    logger.warn('no resume option matched variant — falling back to first non-placeholder', {
      variant,
      options,
      chosenIndex: bestIdx,
      chosenLabel: options[bestIdx],
    });
  } else {
    logger.info('resume selected', {
      variant,
      score: bestScore,
      chosenIndex: bestIdx,
      chosenLabel: options[bestIdx],
    });
  }

  await dropdown.selectOption({ index: bestIdx });
}
