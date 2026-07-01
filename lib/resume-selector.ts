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
  /\bai engineer\b/i,
  /\bartificial intelligence engineer\b/i,
  /\bmachine learning engineer\b/i,
  /\bml engineer\b/i,
];

const PM_HINTS = /delivery|stakeholder|programme?|coordination|governance|roadmap/i;
const SE_HINTS = /code|build|architecture|backend|frontend|infrastructure|api|platform|engineer/i;

export function resolveResumeVariant(jobTitle: string, searchName: string): ResumeVariant {
  const title = jobTitle ?? '';
  const ctx = `${title} ${searchName}`;

  if (PM_TITLE_PATTERNS.some((r) => r.test(title))) return 'pm';
  if (SE_TITLE_PATTERNS.some((r) => r.test(title))) return 'se';

  // For consultant/advisory titles, try to determine technical vs delivery focus
  // from surrounding context words. Default to SE if still ambiguous.
  if (/ai (integration |solution |technology )?consultant|automation consultant|integration specialist|ai advisor/i.test(title)) {
    if (PM_HINTS.test(ctx)) return 'pm';
    return 'se'; // AI consultant with no PM signals → SE resume
  }

  if (PM_TITLE_PATTERNS.some((r) => r.test(searchName))) return 'pm';
  if (SE_TITLE_PATTERNS.some((r) => r.test(searchName))) return 'se';

  return 'se';
}

const KEYWORDS: Record<ResumeVariant, string[]> = {
  pm: ['project', 'manager', 'pm', 'delivery', 'program', 'coordinator'],
  se: ['software', 'engineer', 'developer', 'fullstack', 'backend', 'cloud', 'technical', 'engineering', 'stack'],
};

// Fully anchored (^…$) so we don't over-match real filenames like
// "Select_Rumman_Data_Analyst.pdf" or "Pick — Backend Resume.pdf". SEEK's
// "Please select a resumé" (accented é, trailing chars) still matches via the
// `.*$` tail on the `please\s+select` / `select a resum` alternatives. The
// empty/whitespace-only case is handled by the isPlaceholderLabel `!t`
// early-return, so we don't need a `\s*` alternative here (which previously
// matched zero-width and broke selectOption).
export const PLACEHOLDER_RE = /^(--+.*|please\s+select.*|select a resum.*|select( one)?|choose( one)?|pick( one)?)$/i;

export function isPlaceholderLabel(label: string): boolean {
  const t = label.trim();
  if (!t) return true;
  return PLACEHOLDER_RE.test(t);
}

/**
 * Pure scoring/index-picking logic for the resume dropdown, extracted so it can
 * be unit-tested without a Playwright page. Returns the chosen option index.
 *
 * Throws `Error('resume_no_valid_option')` when there is no selectable
 * non-placeholder option — this cascades into a `resume_no_valid_option`
 * failureReason in the SEEK platform layer instead of a 30s selectOption timeout.
 */
export function pickResumeIndex(options: string[], variant: ResumeVariant): number {
  if (options.length === 0) {
    throw new Error('resume_no_valid_option');
  }

  const firstRealIdx = options.findIndex((o) => !isPlaceholderLabel(o));
  const keywords = KEYWORDS[variant];
  // Never default to index 0 when it's a placeholder — start at the first real option.
  let bestIdx = firstRealIdx >= 0 ? firstRealIdx : 0;
  let bestScore = 0;

  options.forEach((text, i) => {
    if (isPlaceholderLabel(text)) return;
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

  // Invariant: never return an index that points at a placeholder — the option
  // is disabled and selectOption would time out at 30s, cascading to
  // unexpected_error for every job.
  if (isPlaceholderLabel(options[bestIdx] ?? '')) {
    throw new Error('resume_no_valid_option');
  }

  return bestIdx;
}

export async function selectResume(page: Page, variant: ResumeVariant): Promise<void> {
  const changeRadio = page.locator('input[name="resume-method"][value="change"]');
  if (await changeRadio.isVisible().catch(() => false)) {
    await changeRadio.click();
    await page.waitForTimeout(500);
    logger.debug('resume mode: change selected');
  }

  // Prefer a resume-specific select (by name/id/data attribute) before falling
  // back to the first <select> on the page — avoids matching employer-question
  // dropdowns that may appear earlier in the DOM.
  const resumeSelectLocator = page.locator(
    'select[name*="resume" i], select[id*="resume" i], select[data-automation*="resume" i]'
  );
  const hasSpecificSelect = (await resumeSelectLocator.count()) > 0;
  const dropdown = hasSpecificSelect ? resumeSelectLocator.first() : page.locator('select').first();

  const dropdownReady = await dropdown.waitFor({ timeout: 8_000 }).then(() => true).catch(() => false);
  if (!dropdownReady) {
    logger.warn('resume dropdown not found', { variant, usedSpecificSelector: hasSpecificSelect });
    return;
  }

  const options = await dropdown.locator('option').allTextContents();
  if (options.length === 0) {
    logger.warn('resume dropdown has no options', { variant });
    return;
  }

  // Delegate the pure scoring/index-picking to pickResumeIndex so the same
  // logic is exercised by unit tests without a live Playwright page.
  let bestIdx: number;
  try {
    bestIdx = pickResumeIndex(options, variant);
  } catch (err) {
    if (err instanceof Error && err.message === 'resume_no_valid_option') {
      logger.error('resume dropdown has no selectable non-placeholder option — aborting', {
        variant,
        options,
        totalOptions: options.length,
      });
    }
    throw err;
  }

  logger.info('resume selected', {
    variant,
    chosenIndex: bestIdx,
    chosenLabel: options[bestIdx],
    totalOptions: options.length,
  });

  await dropdown.selectOption({ index: bestIdx });
}
