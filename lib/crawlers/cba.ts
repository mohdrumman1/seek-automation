import { Page, Locator } from '@playwright/test';
import { CompanyCrawler, CrawlerJobLink, CrawlerSearch } from './types';
import { logger } from '../logger';
import { openSignInModalViaAlreadyHaveAccount } from '../ats/workday';

const CBA_SEARCHES: CrawlerSearch[] = [
  {
    name: 'cba-pm',
    url: 'https://cba.wd3.myworkdayjobs.com/CommBank_Careers?q=project%20manager&locationCountry=d903bb3fedad45039383f6de334ad4db',
    resumeVariant: 'pm',
  },
  {
    name: 'cba-se',
    url: 'https://cba.wd3.myworkdayjobs.com/CommBank_Careers?q=software%20engineer&locationCountry=d903bb3fedad45039383f6de334ad4db',
    resumeVariant: 'se',
  },
];

const CBA_BASE = 'https://cba.wd3.myworkdayjobs.com';
const CBA_SEARCH_HOME = 'https://cba.wd3.myworkdayjobs.com/CommBank_Careers?locationCountry=d903bb3fedad45039383f6de334ad4db';

// Signals that the current Workday tenant page is already authenticated —
// header avatar / candidate menu / Sign Out. Any one of these being visible
// means the session cookies in the browser context are still valid.
const AUTHENTICATED_SEL =
  '[data-automation-id="candidateHomeMenu"], ' +
  '[data-automation-id="utilityButtonCandidateHomeMenu"], ' +
  '[data-automation-id="candidateMenuItemsButton"], ' +
  'button:has-text("Sign Out"), a:has-text("Sign Out")';

// Pre-authenticate ONCE on the CBA Workday search page before any job scraping
// or per-job apply runs. Session cookies persist in the browser context, so
// every downstream `page.goto(job_url)` and `Apply` click sees an active
// candidate session and skips the sign-in wall entirely.
//
// Return `true` on confirmed sign-in (or already-authenticated), `false` on
// any failure — caller must abort the run rather than fall through to the
// per-job sign-in fallback (that path is what this replaces).
//
// Toggle chain + scope resolution now delegated to
// `openSignInModalViaAlreadyHaveAccount` in lib/ats/workday.ts so both
// preAuthCba (search page) and per-job workday.ts sign-in share ONE selector
// priority order. Only the field-fill and success-race logic stays local
// because the success signal is CBA-tenant-specific (candidateHomeMenu).
export async function preAuthCba(
  page: Page,
  email: string,
  password: string,
): Promise<boolean> {
  try {
    await page.goto(CBA_SEARCH_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (err) {
    logger.warn('cba: pre-auth — search page nav failed', { error: String(err).slice(0, 200) });
    return false;
  }
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1_500);

  // Already authenticated (cached cookies from previous run in the same context)?
  if (await page.locator(AUTHENTICATED_SEL).first().isVisible({ timeout: 2_000 }).catch(() => false)) {
    logger.info('cba: pre-auth — already authenticated (candidate menu visible)');
    return true;
  }

  // Toggle-first strategy: open the Sign In modal via the priority-ordered
  // toggle chain (Already-have-account → signInLink → header). Helper waits
  // up to 10s for the modal to open, verified by signInSubmitButton visibility
  // OR a Sign In heading in [role="dialog"]. Returned scope is dialog OR
  // <form>-with-submit — never body — so downstream fills cannot leak onto
  // the Create Account form underneath (which was causing the "bot scrolling
  // around on Create Account panel" flakiness before this rewrite).
  const scope = await openSignInModalViaAlreadyHaveAccount(page);
  if (scope === null) {
    // Helper couldn't open a sign-in view. Two benign causes exist:
    //   a. AUTHENTICATED_SEL flickered post-networkidle and we missed it above.
    //   b. Workday remembered the session server-side, so no toggle and no
    //      sign-in submit ever rendered — nothing to sign into.
    // Re-check AUTHENTICATED_SEL with a longer window AND confirm no sign-in
    // submit exists anywhere on the page before treating as already-authed.
    const stillHasSubmit = await page
      .locator('[data-automation-id="signInSubmitButton"]')
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    const nowAuthed = await page
      .locator(AUTHENTICATED_SEL)
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    if (nowAuthed || !stillHasSubmit) {
      logger.info('cba: pre-auth — no sign-in surface rendered (session likely remembered by Workday)');
      return true;
    }
    // Helper already logged sign_in_modal_did_not_open — no further fallback.
    return false;
  }

  // Email fill — id selectors first, label anchor fallback. Assert non-empty.
  const emailIdSelectors = [
    '[data-automation-id="signInEmail"]',
    '[data-automation-id="email"]',
    '[data-automation-id="userName"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[type="email"]',
  ];
  let emailField: Locator | null = null;
  for (const sel of emailIdSelectors) {
    const cand = scope.locator(sel).first();
    if (await cand.isVisible({ timeout: 500 }).catch(() => false)) { emailField = cand; break; }
  }
  if (!emailField) {
    for (const re of [/email address/i, /^\s*email\s*$/i, /user ?name/i]) {
      const cand = scope.getByLabel(re).first();
      if (await cand.isVisible({ timeout: 500 }).catch(() => false)) { emailField = cand; break; }
    }
  }
  if (!emailField) {
    logger.warn('cba: pre-auth — email field not found in sign-in modal');
    return false;
  }
  await emailField.fill('').catch(() => {});
  await emailField.fill(email).catch(() => {});
  if (!(((await emailField.inputValue().catch(() => '')) ?? '').trim())) {
    logger.warn('cba: pre-auth — email fill did not land');
    return false;
  }

  // Password fill.
  const passField = scope.locator('[data-automation-id="password"], input[type="password"]').first();
  if (!(await passField.isVisible({ timeout: 2_000 }).catch(() => false))) {
    logger.warn('cba: pre-auth — password field not found in sign-in modal');
    return false;
  }
  await passField.fill('').catch(() => {});
  await passField.fill(password).catch(() => {});
  if (!(((await passField.inputValue().catch(() => '')) ?? '').trim())) {
    logger.warn('cba: pre-auth — password fill did not land');
    return false;
  }

  // Blur password to force React state commit before submit fires. Workday's
  // controlled inputs sometimes hold onto stale state until the field blurs.
  // ponytail: Tab is the cheapest blur; upgrade to explicit dispatchEvent only
  // if we later see the DOM readback below match while submit still rejects.
  await passField.press('Tab').catch(() => {});

  // Pre-submit instrumentation (SAFE — logs LENGTHS only, never the password
  // characters). Distinguishes "creds correct but fill didn't land" from
  // "creds landed and Workday still rejected them" the next headed run.
  const emailDom = await emailField.inputValue().catch(() => '');
  const passDom  = await passField.inputValue().catch(() => '');
  const emailTail = email.slice(-3);
  logger.info(
    `cba: pre-auth — pre-submit lengths: email.length=${email.length} password.length=${password.length} email.tail=${emailTail}`,
  );
  logger.info(
    `cba: pre-auth — pre-submit DOM: email.length=${emailDom.length} password.length=${passDom.length}`,
  );

  // Single-shot submit. Escalating retries (Enter → form.submit) removed —
  // three attempts on the same creds in ~45s likely tripped Workday's rate
  // limiter and surfaced a spurious "wrong password" banner even when the
  // creds were correct. One honest attempt gives an honest signal.
  const submit = scope.locator(
    '[data-automation-id="signInSubmitButton"], ' +
    'button:has-text("Sign In"):not([data-automation-id="signInLink"]):not([data-automation-id="utilityButtonSignIn"]), ' +
    'input[type="submit"][value*="Sign In" i]'
  ).first();
  if (!(await submit.isVisible({ timeout: 2_000 }).catch(() => false))) {
    logger.warn('cba: pre-auth — submit button not visible');
    return false;
  }
  await submit.scrollIntoViewIfNeeded().catch(() => {});
  await submit.click().catch(async (err) => {
    // Click's own actionability wait already retried for the full timeout, so
    // a throw here means the button stayed non-actionable (covered, disabled,
    // or off-screen) the whole time — log what's actually sitting at its
    // center point so the next failure's logs say why, instead of just that.
    const blocker = await page.evaluate(() => {
      const el = document.querySelector('[data-automation-id="signInSubmitButton"]');
      if (!el) return 'submit_button_not_in_dom';
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!top) return 'no_element_at_point';
      return top === el || el.contains(top)
        ? 'button_itself'
        : `${top.tagName.toLowerCase()}.${Array.from(top.classList).join('.')}`;
    }).catch(() => 'evaluate_failed');
    logger.warn('cba: pre-auth — submit click threw', {
      error: String(err).slice(0, 200),
      blocker,
    });
  });

  // Race the terminal signals. Rejection/lockout regexes are scoped to the
  // sign-in scope so unrelated page text can't trip them. Success requires an
  // honest post-auth signal — AUTHENTICATED_SEL visible OR URL change to a
  // candidate-portal path within 10s. Modal-close alone (submit hidden) is NOT
  // treated as success: a swallowed submit or a spinner-timeout can hide the
  // button without actually authenticating, and we've been burned by that.
  const rejectionRe = /wrong.*(email|password)|didn['’]?t\s+recognize|invalid|incorrect/i;
  const lockoutRe   = /account.*locked|locked\s*out|try again later|too many attempts/i;
  // ponytail: candidate-portal URL match is a conservative pattern —
  // `candidateHome`, `userHome`, and generic `/candidate/` cover every Workday
  // tenant we've observed. Upgrade to a per-tenant allow-list if a tenant ever
  // redirects somewhere else that we DO want to treat as success.
  const candidatePortalRe = /candidateHome|userHome|\/candidate\//i;

  type RaceOutcome = 'success' | 'rejected' | 'locked' | 'timeout';
  const outcome = await Promise.race<RaceOutcome>([
    page.locator(AUTHENTICATED_SEL).first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .then<RaceOutcome>(() => 'success').catch<RaceOutcome>(() => 'timeout'),
    page.waitForURL(candidatePortalRe, { timeout: 10_000 })
      .then<RaceOutcome>(() => 'success').catch<RaceOutcome>(() => 'timeout'),
    scope.getByText(rejectionRe).first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then<RaceOutcome>(() => 'rejected').catch<RaceOutcome>(() => 'timeout'),
    scope.getByText(lockoutRe).first()
      .waitFor({ state: 'visible', timeout: 15_000 })
      .then<RaceOutcome>(() => 'locked').catch<RaceOutcome>(() => 'timeout'),
  ]);

  if (outcome === 'success') {
    logger.info('cba: pre-auth — signed in successfully (session cookies now active for context)');
    return true;
  }
  if (outcome === 'rejected') {
    logger.warn('cba: pre-auth — credentials_rejected_by_workday (rejection banner visible after single-shot submit)');
    return false;
  }
  if (outcome === 'locked') {
    logger.warn('cba: pre-auth — account_locked, wait 15min or reset via Forgot Password');
    return false;
  }
  logger.warn('cba: pre-auth — race_timeout (no success/rejection/lockout signal within 15s)');
  return false;
}

export class CbaCrawler implements CompanyCrawler {
  name = 'cba';
  searches = CBA_SEARCHES;

  async getJobLinks(page: Page, searchUrl: string): Promise<CrawlerJobLink[]> {
    await page.goto(searchUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);

    // Workday lazy-loads listings in batches; click "Load More" until exhausted.
    for (let i = 0; i < 20; i++) {
      const loadMore = page.locator(
        'button:has-text("Load More"), [data-automation-id="loadMoreButton"]'
      ).first();
      if (await loadMore.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await loadMore.click().catch(() => {});
        await page.waitForTimeout(2_000);
      } else {
        // Try a scroll to trigger lazy-load, then re-check
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1_500);
        if (!(await loadMore.isVisible({ timeout: 1_000 }).catch(() => false))) break;
      }
    }

    // Workday job title links use data-automation-id="jobTitle" or href containing the portal name
    const anchors = await page.locator(
      '[data-automation-id="jobTitle"], a[href*="/CommBank_Careers/job/"]'
    ).all();

    const results: CrawlerJobLink[] = [];
    const seen = new Set<string>();

    for (const a of anchors) {
      const href = await a.getAttribute('href').catch(() => null);
      const title = ((await a.textContent().catch(() => '')) ?? '').trim();
      if (!href) continue;

      const abs = href.startsWith('http') ? href : new URL(href, CBA_BASE).toString();

      // Derive a stable jobId from the Workday requisition ID embedded in the URL slug
      // e.g. ".../Senior-Project-Manager_R-0000123456" → "R-0000123456"
      const reqMatch = abs.match(/_(R-[\w]+)\s*$/i);
      const jobId = reqMatch ? reqMatch[1] : (abs.split('/').pop() ?? abs);

      if (seen.has(jobId)) continue;
      seen.add(jobId);

      results.push({ url: abs, title, jobId });
    }

    logger.info('cba: job links scraped', { search: searchUrl.slice(-60), total: results.length });
    return results;
  }
}
