import { Page, Locator } from '@playwright/test';
import { JobDetails, ApplyConfig } from '../platforms/types';
import { ATSResult } from './types';
import {
  ATS_CONTACT, acceptCookies, fillTextByHints, fillCoverLetter,
  uploadResumeFile, getBaseResumePath, hasSensitiveRequiredField,
  answerGenericQuestions, isSuccessPage, getQuestionLabel,
} from './common';
import { captureAndAnalyze, appendErrorLogEntry } from '../error-analyzer';
import { logger } from '../logger';

// Discriminated reason codes returned by `attemptSignInWithPassword`. Every
// distinct return path emits one of these and logs a matching one-liner:
//   `ats: workday — sign-in failed: <reason>`
// so the failure mode is greppable in CI logs. Only 'credentials_rejected'
// should trigger the fallback-password retry — the rest are form-state or
// environment problems where re-submitting the same form is pointless.
//   'ok'                     — sign-in succeeded (submit button gone from DOM)
//   'credentials_rejected'   — Workday explicitly said wrong/invalid/no-match
//   'password_empty'         — password fill didn't land in the input
//   'password_field_not_found' — password locator returned no visible match
//   'submit_not_found'       — submit button locator returned no visible match
//   'submit_disabled'        — submit visible but disabled (missing/invalid field)
//   'submit_not_clickable'   — click() threw (element covered, detached, etc.)
//   'race_timeout'           — 15s Promise.race elapsed with no terminal signal
//                              (DOM snapshot of the modal appended to error-log.json)
//   'unexpected_navigation'  — URL changed post-click AND submit still visible
//                              (redirected to a fresh form somewhere else)
//   `exception:<msg>`        — thrown error caught by outer try/catch, first
//                              100 chars of err.message inlined for grepping
export type WorkdaySignInReason =
  | 'ok'
  | 'credentials_rejected'
  | 'password_empty'
  | 'password_field_not_found'
  | 'submit_not_found'
  | 'submit_disabled'
  | 'submit_not_clickable'
  | 'race_timeout'
  | 'unexpected_navigation'
  | `exception:${string}`;

const WALL_SEL =
  '[data-automation-id="createAccountLink"], [data-automation-id="signInLink"], ' +
  'a:has-text("Create Account"), button:has-text("Create Account"), ' +
  'h1:has-text("Sign In"), h2:has-text("Create an Account")';

// Priority-ordered toggle chain to open the Workday Sign In modal from a
// Create Account panel or a first-visit page:
//   1. "Already have an account? Sign In" link/button (authoritative — this is
//      the explicit user-visible toggle on CBA's /apply/ page).
//   2. `data-automation-id="signInLink"` (Workday tenant standard id).
//   3. Header-based fallbacks (`utilityButtonSignIn`, header text) for panel-
//      swap tenants that expose Sign In only in the top nav.
// The old behaviour matched `button:has-text("Sign In")` page-wide, which on
// CBA landed on the Sign In submit inside the Create Account panel — meaning
// the bot filled Create Account fields instead of opening the modal.
const SIGN_IN_TOGGLE_SELECTORS = [
  'button:has-text("Already have an account")',
  'a:has-text("Already have an account")',
  '[data-automation-id="signInLink"]',
  '[data-automation-id="utilityButtonSignIn"]',
  'header button:has-text("Sign In")',
  'header a:has-text("Sign In")',
];

// Resolve the container the sign-in fills must be scoped to. Never returns
// `page.locator('body')` — that would leak fills onto the Create Account form
// rendered underneath on CBA's /apply/ page. Priority:
//   1. `[role="dialog"]` that contains the sign-in submit button (overlay tenants).
//   2. Nearest `<form>` ancestor of the submit button (inline panel — CBA /apply/
//      renders Email + Password + Sign In button as an inline panel between the
//      wizard breadcrumb and the "Don't have an account yet?" toggle at the
//      bottom; there is NO [role="dialog"] wrapper).
//   3. Nearest ancestor of the submit that also contains an Email Address label
//      (defensive fallback for tenants that wrap sign-in in a <section>/<div>
//      rather than a <form>).
// ponytail: no `body` fallback — if none of the three match, downstream fills
// return false and the caller bails cleanly. Upgrade path: add a fourth rung
// keyed off a distinct DOM signature if a real tenant slips through.
async function resolveSignInScope(page: Page): Promise<Locator> {
  // 1. Modal case.
  const dialog = page.locator('[role="dialog"]:has([data-automation-id="signInSubmitButton"])').first();
  if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) return dialog;

  // 2 & 3 anchor off the submit button — must exist in DOM for any sign-in path.
  const submit = page.locator('[data-automation-id="signInSubmitButton"]').first();
  await submit.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

  // 2. Inline panel wrapped in <form> (CBA /apply/).
  const formScope = submit.locator('xpath=ancestor::form[1]');
  if ((await formScope.count().catch(() => 0)) > 0) return formScope.first();

  // 3. Non-form panel: nearest ancestor with an Email Address label and a button.
  return submit.locator(
    'xpath=ancestor::*[.//label[normalize-space()="Email Address"] and .//button][1]'
  );
}

// Open the Workday Sign In modal via the "Already have an account? Sign In"
// toggle chain, and return the scope container for downstream fills. Returns
// null on any failure (toggle not found OR toggle clicked but modal didn't open
// within 10s). Caller MUST treat null as failure — do NOT fall through to
// Create Account, because clicking the toggle expressed sign-in intent and
// blindly creating a new account risks a duplicate.
//
// Modal-opened proof: `signInSubmitButton` visible OR a `Sign In` heading
// inside `[role="dialog"]` — either constitutes "the sign-in view is showing".
export async function openSignInModalViaAlreadyHaveAccount(page: Page): Promise<Locator | null> {
  const signInSubmit = page.locator('[data-automation-id="signInSubmitButton"]').first();
  // Already open? No toggle click needed.
  if (await signInSubmit.isVisible({ timeout: 500 }).catch(() => false)) {
    return resolveSignInScope(page);
  }
  let clickedSelector: string | null = null;
  for (const sel of SIGN_IN_TOGGLE_SELECTORS) {
    const tog = page.locator(sel).first();
    if (!(await tog.isVisible({ timeout: 500 }).catch(() => false))) continue;
    await tog.click().catch(() => {});
    clickedSelector = sel;
    break;
  }
  if (!clickedSelector) {
    logger.warn('ats: workday — sign_in_modal_did_not_open (no toggle selector matched)');
    return null;
  }
  const openedByBtn = signInSubmit.waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true).catch(() => false);
  const openedByHeading = page.locator('[role="dialog"] :is(h1, h2, h3):has-text("Sign In")').first()
    .waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
  const opened = await Promise.race([openedByBtn, openedByHeading]);
  if (!opened) {
    logger.warn('ats: workday — sign_in_modal_did_not_open (clicked toggle but no submit/heading in 10s)', {
      selector: clickedSelector,
    });
    return null;
  }
  return resolveSignInScope(page);
}

export async function applyWorkday(
  page: Page,
  details: JobDetails,
  config: ApplyConfig,
  resumePath: string | null,
  coverLetter: string,
): Promise<ATSResult> {
  const ctx = { job_title: details.title, company: details.company };

  await acceptCookies(page);

  // Click the top-level "Apply" button on the Workday job listing page.
  const applyBtn = page.locator(
    '[data-automation-id="adventureButton"], button:has-text("Apply for this job"), button:has-text("Apply")'
  ).first();
  if (await applyBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await applyBtn.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_000);
  }

  // "Start Your Application" modal — Workday shows this for tenants that support
  // resumé autofill, LinkedIn, or prior-application reuse. Prefer the guest/manual
  // path. "Use My Last Application" is the next best option (avoids re-entering data).
  await dismissStartYourApplicationModal(page);

  // Check for account creation / sign-in wall.
  const hasWall = await page.locator(WALL_SEL).first().isVisible({ timeout: 3_000 }).catch(() => false);

  if (hasWall) {
    // Prefer the "Apply Manually" guest path if offered.
    const manualBtn = page.locator(
      '[data-automation-id="applyManually"], a:has-text("Apply Manually"), button:has-text("Apply Manually")'
    ).first();
    if (await manualBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await manualBtn.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
    } else {
      // No guest path — sign in with existing account or create a new one.
      const accountResult = await signInOrCreateAccount(page, ctx);
      if (accountResult === 'verify_email') {
        await captureAndAnalyze(page, 'ats_workday_verify_email', ctx);
        return { status: 'needs_manual_review', reason: 'workday_account_verify_email' };
      }
      if (accountResult !== 'ok') {
        // Page/context may already be closed if Workday killed the session
        // after repeated auth failures — captureAndAnalyze would then throw
        // and bubble up as ats_workday_error. Semantically this is still
        // ats_requires_account, so guard the capture and return either way.
        if (!page.isClosed()) {
          await captureAndAnalyze(page, 'ats_workday_account_failed', ctx).catch(() => {});
        }
        return { status: 'skipped', reason: 'ats_requires_account' };
      }
      // After sign-in Workday sometimes redirects back to the job listing — click Apply again.
      if (await applyBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await applyBtn.click().catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(1_000);
      }
    }
  }

  const resolvedResume = resumePath ?? getBaseResumePath(config.resumeVariant);
  let uploadedResume = false;
  let lastUrl = '';

  // Multi-page wizard loop: fill → next → check success (up to 10 pages).
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.waitForTimeout(1_500);
    const currentUrl = page.url();

    // Modal can reappear after sign-in redirects back to the listing page.
    await dismissStartYourApplicationModal(page);

    if (await isSuccessPage(page)) {
      logger.info('ats: workday — applied', ctx);
      return { status: 'applied' };
    }

    // Account wall can reappear after navigation (different Workday tenant behaviour).
    if (await page.locator(WALL_SEL).first().isVisible({ timeout: 1_000 }).catch(() => false)) {
      await captureAndAnalyze(page, 'ats_workday_wall_mid_apply', ctx);
      return { status: 'skipped', reason: 'ats_requires_account' };
    }

    // Stuck detection: same URL two iterations in a row and not the first.
    if (currentUrl === lastUrl && attempt > 0) {
      await captureAndAnalyze(page, 'ats_workday_no_submit', ctx);
      return { status: 'failed', reason: 'ats_workday_no_progress' };
    }
    lastUrl = currentUrl;

    // Safety gate: never fill sensitive required fields.
    const sensitive = await hasSensitiveRequiredField(page);
    if (sensitive) {
      await captureAndAnalyze(page, 'ats_workday_sensitive_field', ctx);
      return { status: 'needs_manual_review', reason: `sensitive_field:${sensitive.slice(0, 60)}` };
    }

    // Resume upload (only first time an upload input is present).
    if (resolvedResume && !uploadedResume) {
      const fileInput = page.locator(
        '[data-automation-id="file-upload-input-ref"], input[type="file"]'
      ).first();
      if (await fileInput.count() > 0) {
        uploadedResume = await uploadResumeFile(page, resolvedResume);
        await page.waitForTimeout(1_000);
      }
    }

    // Core identity fields via Workday-specific data-automation-id first,
    // then generic label hints as fallback.
    await fillNameAndContact(page);

    // Cover letter textarea.
    await fillCoverLetter(page, coverLetter);

    // Employer screening questions (selects, radios, checkboxes, textareas).
    await answerGenericQuestions(page, config.kb);

    // Voluntary disclosure pages — prefer "not to answer" options.
    await handleVoluntaryDisclosures(page);

    // Click the primary navigation button (Next / Save and Continue / Submit).
    // Broadened selector list — Workday tenant customisation varies.
    const navBtn = page.locator(
      '[data-automation-id="bottom-navigation-next-button"], ' +
      '[data-automation-id="wd-CommandButton_uic_okButton"], ' +
      '[data-automation-id*="submit" i], ' +
      'button:has-text("Save and Continue"), button:has-text("Next"), ' +
      'button:has-text("Continue"), button:has-text("Submit application"), ' +
      'button:has-text("Submit Application"), button:has-text("Submit"), ' +
      'button:has-text("Review and Submit"), button:has-text("Apply now"), ' +
      'button[type="submit"], input[type="submit"], ' +
      '[data-test-id*="submit" i], [data-testid*="submit" i], [data-cy*="submit" i]'
      // NB: intentionally NOT including `input[value*="Submit" i]` (matches hidden/text
      // inputs whose value contains "Submit", e.g. <input type="button" value="Submit CV via email">)
      // or `[role="button"]:has-text("Submit")` — Workday renders step-nav pills as
      // <div role="button">Submit</div> which appear before the real CTA in DOM order,
      // causing `.first()` to click the pill and never submit. The explicit selectors
      // above (bottom-navigation-next-button, wd-CommandButton_uic_okButton, Submit
      // application, Review and Submit) cover the real cases.
    ).first();

    if (await navBtn.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await navBtn.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    } else {
      // No navigation button found — capture for debugging.
      await captureAndAnalyze(page, 'ats_workday_no_nav_button', ctx);
      break;
    }
  }

  await captureAndAnalyze(page, 'ats_workday_no_submit', ctx);
  return { status: 'failed', reason: 'ats_workday_no_submit' };
}

// Handles the "Start Your Application" modal that Workday shows before the wizard.
// Preference order: Apply Manually (guest) → Use My Last Application → Autofill with Resume.
async function dismissStartYourApplicationModal(page: Page): Promise<void> {
  const candidates = [
    'button:has-text("Apply Manually")',
    '[data-automation-id="applyManually"]',
    'button:has-text("Use My Last Application")',
    'button:has-text("Autofill with Resume")',
  ];
  for (const sel of candidates) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
      return;
    }
  }
}

// Resolve the sign-in email input inside the given `scope` (modal or body).
// Workday tenant DOMs vary: some expose `data-automation-id="signInEmail"`,
// others `data-automation-id="email"` or `userName`, and CBA's overlay renders
// a plain `input[type="text"]` with only a "Email Address" label — so fall back
// to label anchoring when no id selector matches. Returns true only if fill
// actually landed (guards against selectors matching a hidden/disabled twin).
async function fillSignInEmail(scope: Locator, email: string): Promise<boolean> {
  const idSelectors = [
    '[data-automation-id="signInEmail"]',
    '[data-automation-id="email"]',
    '[data-automation-id="userName"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[type="email"]',
  ];
  let field: Locator | null = null;
  for (const sel of idSelectors) {
    const cand = scope.locator(sel).first();
    if (await cand.isVisible({ timeout: 500 }).catch(() => false)) {
      field = cand;
      break;
    }
  }
  if (!field) {
    for (const re of [/email address/i, /^\s*email\s*$/i, /user ?name/i]) {
      const cand = scope.getByLabel(re).first();
      if (await cand.isVisible({ timeout: 500 }).catch(() => false)) {
        field = cand;
        break;
      }
    }
  }
  if (!field) return false;
  await field.fill('').catch(() => {});
  await field.fill(email).catch(() => {});
  const val = await field.inputValue().catch(() => '');
  return val.trim().length > 0;
}

// One sign-in attempt with the given password. Caller is responsible for having
// already opened the sign-in modal/panel and filled the email field. `scope` is
// the sign-in modal/panel container — passing `page.locator('body')` degrades
// to page-wide (safe when sign-in is a full-page swap, not a modal overlay).
// See `WorkdaySignInReason` above for the full set of returns and their meaning.
// Only 'credentials_rejected' should trigger the fallback-password retry — the
// others indicate a form/input/env problem where retrying the same submit is
// pointless. Every failure return logs `ats: workday — sign-in failed: <reason>`
// immediately before returning so CI logs are unambiguous.
async function attemptSignInWithPassword(
  page: Page,
  scope: Locator,
  password: string,
): Promise<WorkdaySignInReason> {
  const urlBeforeClick = page.url();
  try {
    const passField = scope.locator(
      '[data-automation-id="password"], input[type="password"]'
    ).first();
    if (!(await passField.isVisible({ timeout: 3_000 }).catch(() => false))) {
      logger.info('ats: workday — sign-in failed: password_field_not_found');
      return 'password_field_not_found';
    }

    // Clear any previous attempt's value (defensive when retrying with fallback).
    await passField.fill('').catch(() => {});
    await passField.fill(password).catch(() => {});
    const passVal = await passField.inputValue().catch(() => '');
    if (!passVal) {
      logger.info('ats: workday — sign-in failed: password_empty');
      return 'password_empty';
    }

    const signInSubmit = scope.locator(
      '[data-automation-id="signInSubmitButton"], ' +
      'button:has-text("Sign In"):not([data-automation-id="signInLink"]), ' +
      'input[type="submit"][value*="Sign In" i]'
    ).first();
    if (!(await signInSubmit.isVisible({ timeout: 3_000 }).catch(() => false))) {
      logger.info('ats: workday — sign-in failed: submit_not_found');
      return 'submit_not_found';
    }
    if (await signInSubmit.isDisabled().catch(() => false)) {
      logger.info('ats: workday — sign-in failed: submit_disabled');
      return 'submit_disabled';
    }
    let clickErr: Error | null = null;
    await signInSubmit.click().catch((err) => { clickErr = err as Error; });
    if (clickErr) {
      const msg = (clickErr as Error).message?.slice(0, 100) ?? '';
      logger.info(`ats: workday — sign-in failed: submit_not_clickable (${msg})`);
      return 'submit_not_clickable';
    }
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1_500);

    // Race the two terminal signals with a 15s cap: modal gone = ok; credential-
    // rejection text in an alert = credentials_rejected. 5s was too aggressive
    // for Workday's post-click backend round-trip on slow tenants (2026-07-19);
    // if race_timeout still fires at 15s it's a real bug not a race.
    const credErrRe = /incorrect|wrong|invalid|does not match|didn'?t match|no account/i;
    const errLoc = page.locator(
      '[data-automation-id="signInGlobalErrorMessage"], ' +
      '[data-automation-id*="errorMessage" i], [role="alert"]'
    ).first();
    const outcome = await Promise.race<'ok' | 'credentials_rejected' | null>([
      signInSubmit.waitFor({ state: 'hidden', timeout: 15_000 })
        .then(() => 'ok' as const).catch(() => null),
      (async () => {
        if (!(await errLoc.isVisible({ timeout: 15_000 }).catch(() => false))) return null;
        const text = (await errLoc.textContent().catch(() => '') ?? '').trim();
        return credErrRe.test(text) ? 'credentials_rejected' as const : null;
      })(),
    ]);
    if (outcome === 'ok') return 'ok';
    if (outcome === 'credentials_rejected') {
      logger.info('ats: workday — sign-in failed: credentials_rejected');
      return 'credentials_rejected';
    }

    // Neither terminal signal fired inside 15s — recheck once so we don't leave
    // on a stale read (Workday's networkidle sometimes settles late).
    const stillVisible = await signInSubmit.isVisible({ timeout: 500 }).catch(() => false);
    if (!stillVisible) return 'ok';
    const errText = (await errLoc.textContent({ timeout: 500 }).catch(() => '') ?? '').trim();
    if (credErrRe.test(errText)) {
      logger.info('ats: workday — sign-in failed: credentials_rejected');
      return 'credentials_rejected';
    }

    // URL changed AND submit is still visible → landed on a different sign-in
    // form somewhere unexpected (SSO redirect, tenant swap, etc). Distinct from
    // race_timeout because the page navigated at all.
    const urlAfterClick = page.url();
    if (urlAfterClick !== urlBeforeClick) {
      logger.info(
        `ats: workday — sign-in failed: unexpected_navigation ` +
        `(from ${urlBeforeClick} to ${urlAfterClick})`
      );
      return 'unexpected_navigation';
    }

    // True race timeout: submit still visible, no error text, no navigation.
    // Capture the modal's current DOM state so the next investigator can see
    // what Workday left behind (spinner still spinning? validation-error node
    // we don't recognise? partially-hidden overlay?).
    // ponytail: 500-char cap, add pagination or diff mode if we ever want more.
    const modalHtml = ((await scope.innerHTML().catch(() => '')) || '').slice(0, 500);
    appendErrorLogEntry({
      error_type: 'workday_signin_race_timeout',
      url: urlAfterClick,
      page_title: await page.title().catch(() => ''),
      analysis: `Modal DOM after 15s race timeout (submit still visible, no cred error, no nav):\n${modalHtml}`,
    });
    logger.info('ats: workday — sign-in failed: race_timeout (modal DOM saved to data/error-log.json)');
    return 'race_timeout';
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 100);
    logger.info(`ats: workday — sign-in failed: exception:${msg}`);
    return `exception:${msg}` as WorkdaySignInReason;
  }
}

// Sign in with existing credentials, or create a new account if needed.
// Returns: 'ok' (ready to apply), 'verify_email' (need to verify inbox), 'failed' (unrecoverable).
async function signInOrCreateAccount(
  page: Page,
  ctx: { job_title?: string; company?: string },
): Promise<'ok' | 'verify_email' | 'failed'> {
  const pwd = process.env.WORKDAY_PASSWORD ?? '';
  const pwdFallback = process.env.WORKDAY_PASSWORD_FALLBACK ?? '';

  // ── Try Sign In first (account may already exist from a prior run) ─────────
  // Workday tenants like CBA default the /apply/ page to a CREATE ACCOUNT panel;
  // a separate "Sign In" modal only opens when the "Already have an account?
  // Sign In" toggle is clicked. Route through the shared helper which:
  //   1. Uses the priority-ordered toggle chain (Already-have-account →
  //      signInLink → header) so we never accidentally click a Sign In control
  //      inside the Create Account form.
  //   2. Waits up to 10s for the modal to open, verified by `signInSubmitButton`
  //      visibility OR a dialog `Sign In` heading. If neither shows, returns null.
  //   3. Returns a scope Locator that is either the modal `[role="dialog"]` or
  //      the sign-in `<form>` — never `body`, so downstream fills cannot leak
  //      onto the Create Account form beneath the modal.
  const scope = await openSignInModalViaAlreadyHaveAccount(page);
  if (scope === null) {
    // Helper already logged `sign_in_modal_did_not_open`. Per spec: NO further
    // fallback — we do NOT drop to Create Account here, because either
    //   (a) no toggle was found (DOM changed; blindly creating an account
    //       could produce a duplicate), or
    //   (b) toggle was clicked but the modal never showed (Workday backend or
    //       page issue; re-doing anything is guesswork).
    // ponytail: if a real tenant lacks the toggle chain, add it here or to the
    // helper — do not re-enable the create-account fallback for the null case.
    return 'failed';
  }

  // Fill email with a broadened selector chain + label-anchored fallback.
  // Old behaviour matched only `signInEmail`/`autocomplete=username`/`type=email`;
  // CBA's Workday modal renders a plain `input[type="text"]` with a bare
  // "Email Address" label, so those all missed and the field stayed empty —
  // Sign In click then failed on client-side validation, misreported upstream
  // as an auth failure. Assert non-empty and abort BEFORE clicking Sign In so
  // we don't (a) burn a false credential attempt or (b) waste the fallback
  // password retry on what is really a form-fill bug.
  const emailFilled = await fillSignInEmail(scope, ATS_CONTACT.email);
  if (!emailFilled) {
    logger.warn('ats: workday — sign-in aborted: email_empty (modal open but no email input matched or fill did not land)', ctx);
    return 'failed';
  }

  // Attempt with primary password first.
  const primaryResult = await attemptSignInWithPassword(page, scope, pwd);
  if (primaryResult === 'ok') {
    logger.info('ats: workday — signed in to existing account (primary password)', ctx);
    return 'ok';
  }

  // Only a genuine credential rejection warrants retrying with the fallback
  // password; everything else (password_empty, submit_disabled, submit_not_found,
  // race_timeout, unexpected_navigation, exception:*) is a form-state or env
  // bug where re-running the same submit won't help. `attemptSignInWithPassword`
  // has already logged the specific `sign-in failed: <reason>` line — no need
  // to repeat it here.
  if (primaryResult === 'credentials_rejected' && pwdFallback && pwdFallback !== pwd) {
    logger.info('ats: workday — credentials_rejected, retrying with fallback password', ctx);
    const fallbackResult = await attemptSignInWithPassword(page, scope, pwdFallback);
    if (fallbackResult === 'ok') {
      logger.info('ats: workday — signed in to existing account (fallback password)', ctx);
      return 'ok';
    }
    logger.warn(`ats: workday — fallback password also failed (see prior sign-in failed line for reason)`, ctx);
  }

  logger.info('ats: workday — sign in failed, trying create account', ctx);

  // ── Try Create Account ─────────────────────────────────────────────────────
  // Workday may kill the session/close the tab after repeated sign-in failures;
  // guard here so `.locator(...).all()` below doesn't throw
  // "Target page, context or browser has been closed" (2026-07-19 crash).
  if (page.isClosed()) {
    logger.warn('ats: workday — page closed before create-account attempt', ctx);
    return 'failed';
  }

  try {
    const createLink = page.locator(
      '[data-automation-id="createAccountLink"], ' +
      'a:has-text("Create Account"), button:has-text("Create Account"), ' +
      'a:has-text("Create an Account"), button:has-text("Create an Account")'
    ).first();

    if (!await createLink.isVisible({ timeout: 3_000 }).catch(() => false)) {
      logger.warn('ats: workday — no sign-in or create-account option found', ctx);
      return 'failed';
    }

    await createLink.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_500);

    // Fill registration form.
    await fillTextByHints(page, [/e-?mail/i, /username/i], ATS_CONTACT.email);
    await fillTextByHints(page, [/verify.{0,10}email|confirm.{0,10}email|re.?enter.{0,10}email/i], ATS_CONTACT.email);
    await fillTextByHints(page, [/first.?name|given name/i], ATS_CONTACT.firstName);
    await fillTextByHints(page, [/last.?name|surname|family name/i], ATS_CONTACT.lastName);

    // Fill all password inputs (password + confirm-password).
    for (const inp of await page.locator('input[type="password"]').all()) {
      if (!(await inp.isVisible().catch(() => false))) continue;
      const existing = await inp.inputValue().catch(() => '');
      if (!existing) await inp.fill(pwd).catch(() => {});
    }

    // Tick any terms / privacy checkboxes required to enable the submit button.
    for (const cb of await page.locator('input[type="checkbox"]').all()) {
      if (!(await cb.isVisible().catch(() => false))) continue;
      if (await cb.isChecked().catch(() => false)) continue;
      const id = await cb.getAttribute('id').catch(() => null);
      let cbLabel = '';
      if (id) cbLabel = (await page.locator(`label[for="${id}"]`).textContent().catch(() => '')) ?? '';
      if (!cbLabel) {
        cbLabel = await cb.evaluate((el: Element) => el.closest('label')?.textContent ?? '').catch(() => '');
      }
      if (/terms|privacy|consent|agree/i.test(cbLabel)) {
        await cb.click().catch(() => {});
      }
    }

    const submitBtn = page.locator(
      '[data-automation-id="createAccountSubmitButton"], ' +
      'button:has-text("Create Account"), ' +
      'button[type="submit"]:has-text("Create"), ' +
      'input[type="submit"][value*="Create" i]'
    ).first();
    if (await submitBtn.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await submitBtn.click().catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
    }

    // Email verification gate — user must click the link in mohdrumman1@gmail.com.
    const verifyGate = await page.locator(
      'text=/verify your email/i, text=/check your email/i, text=/confirmation email/i, ' +
      'text=/email has been sent/i'
    ).first().isVisible({ timeout: 3_000 }).catch(() => false);
    if (verifyGate) {
      logger.info('ats: workday — account created but email verification required (check mohdrumman1@gmail.com)', ctx);
      return 'verify_email';
    }

    // Any error shown on the page means account creation failed.
    const createError = await page.locator(
      '[data-automation-id="createAccountError"], [role="alert"], .error-message'
    ).first().isVisible({ timeout: 2_000 }).catch(() => false);
    if (createError) {
      logger.warn('ats: workday — create account error on page', ctx);
      return 'failed';
    }

    logger.info('ats: workday — new account created successfully', ctx);
    // Distinctive alarm marker — grep for WORKDAY_ACCOUNT_CREATED_FALLBACK to know
    // when the primary password stopped working and a new account had to be created.
    // User must manually refresh WORKDAY_PASSWORD (and shift the old value to
    // WORKDAY_PASSWORD_FALLBACK) when this fires.
    logger.warn('WORKDAY_ACCOUNT_CREATED_FALLBACK', {
      tenant: (() => {
        try { return new URL(page.url()).hostname; } catch { return page.url(); }
      })(),
      url: page.url(),
      ...ctx,
    });
    return 'ok';
  } catch (err) {
    // ponytail: catch closed-page/context errors and downgrade to 'failed'
    // (caller maps to ats_requires_account). Any other error still bubbles.
    // Upgrade path: build the full "re-open tab and retry create-account" flow
    // if we ever see this fire on a live-account path we could actually recover.
    const msg = String((err as Error)?.message ?? err);
    if (/Target (page|context|browser) has been closed|Target closed|Execution context was destroyed/i.test(msg)) {
      logger.warn('ats: workday — page closed during create-account flow', { ...ctx, error: msg.slice(0, 200) });
      return 'failed';
    }
    throw err;
  }
}

async function fillNameAndContact(page: Page): Promise<void> {
  // Try Workday-specific data-automation-id attributes first.
  const specific: Array<[string, string]> = [
    ['[data-automation-id="legalNameSection_firstName"]', ATS_CONTACT.firstName],
    ['[data-automation-id="legalNameSection_lastName"]',  ATS_CONTACT.lastName],
    ['[data-automation-id="email"]',                      ATS_CONTACT.email],
    ['[data-automation-id="phone-number"]',               ATS_CONTACT.phone],
  ];
  for (const [sel, value] of specific) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      if (!(await el.inputValue().catch(() => ''))) {
        await el.fill(value).catch(() => {});
      }
    }
  }

  // Generic label hints as fallback.
  await fillTextByHints(page, [/first.?name/i, /given name/i],                         ATS_CONTACT.firstName);
  await fillTextByHints(page, [/last.?name/i, /surname/i, /family name/i],              ATS_CONTACT.lastName);
  await fillTextByHints(page, [/^name$/i, /full.?name/i, /your name/i],                 ATS_CONTACT.fullName);
  await fillTextByHints(page, [/e-?mail/i],                                              ATS_CONTACT.email);
  await fillTextByHints(page, [/phone/i, /mobile/i, /contact number/i, /telephone/i],   ATS_CONTACT.phone);
  await fillTextByHints(page, [/city/i, /suburb/i, /town/i],                            ATS_CONTACT.city);
  await fillTextByHints(page, [/post.?code/i, /zip/i],                                  ATS_CONTACT.postcode);
  await fillTextByHints(page, [/linkedin/i],                                             ATS_CONTACT.linkedin);
}

// For voluntary disclosure pages (gender/race/veteran/disability) select "prefer not to answer".
async function handleVoluntaryDisclosures(page: Page): Promise<void> {
  const preferNotRe = /prefer not|decline|choose not|do not wish|not provided/i;
  for (const sel of await page.locator('select').all()) {
    if (!(await sel.isVisible().catch(() => false))) continue;
    const currentVal = await sel.inputValue().catch(() => '');
    if (currentVal) continue;
    const options = await sel.locator('option').allTextContents();
    const preferOpt = options.find((o) => preferNotRe.test(o));
    if (preferOpt) {
      await sel.selectOption({ label: preferOpt }).catch(() => {});
    }
  }
}
