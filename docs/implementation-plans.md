# Implementation Plans — Phases 5, 7 & 10

Architect notes for the SEEK auto-apply bot (TypeScript / Playwright). These plans are written to be implemented directly by a Sonnet coder without follow-up questions. File paths are repo-relative.

Conventions used throughout:
- "seek.ts" = `lib/platforms/seek.ts`
- "apply.ts" = `scripts/apply.ts`
- "types.ts" = `lib/platforms/types.ts`
- Always reuse the existing `logger` (`lib/logger`), `captureAndAnalyze` (`lib/error-analyzer`), and `tracker` (`lib/tracker`) helpers. Do not invent new logging or screenshot machinery.

---

## Status

| Phase | Status | Implemented |
|-------|--------|-------------|
| Phase 5 — External ATS Engine | ✅ Implemented | 2026-05-22 |
| Phase 7 — On-Demand Single-Job Apply | ✅ Implemented | 2026-05-22 |
| Phase 10 — CommBank Direct (Workday) | ✅ Implemented | 2026-05-28 |

### Phase 5 implementation summary (2026-05-22)
- `lib/ats/` created: types.ts, detect.ts, common.ts, index.ts, workday.ts, cornerstone.ts, jobadder.ts, teamtailor.ts, pageup.ts, smartrecruiters.ts, dayforce.ts (stub), successfactors.ts (stub), taleo.ts (stub), randstad.ts (stub)
- `lib/platforms/types.ts`: ApplyResult extended with `atsProvider?`, `externalUrl?`
- `lib/tracker.ts`: JobMeta + APP/SKIP/FAIL_HEADERS extended with `ats_provider`, `external_url`
- `lib/platforms/seek.ts`: `filterByLocation()` added, ATS dispatch wired in place of early-return, CANDIDATE_PROFILE updated with phone/linkedin/website
- `scripts/apply.ts`: atsProvider/externalUrl threaded through jobMeta; summary banner added to single-URL mode
- `scripts/seek-sr.ts`: SmartRecruiters local queue runner (`npm run seek-sr`)
- `scripts/normalise-url.js`: SEEK URL normaliser for workflow_dispatch
- `.github/workflows/seek-apply.yml`: CANDIDATE_PHONE/LINKEDIN/WEBSITE env vars; workflow_dispatch inputs (job_url, dry_run); Run bot step updated for single-job mode
- `.env`: CANDIDATE_PHONE, CANDIDATE_LINKEDIN, CANDIDATE_WEBSITE added

### Phase 7 implementation summary (2026-05-22)
- `workflow_dispatch` inputs: `job_url`, `dry_run`
- `scripts/normalise-url.js`: URL normaliser (bare id, au.seek.com, query-strip)
- Run bot step: builds `$ARGS`, passes `--url` and `--dry-run` through to apply.ts
- Summary banner added to `applyToSingleUrl` in apply.ts

---

## Section 1: Phase 5 — External ATS Engine

### 1.0 Goal & current behaviour

Today, when the SEEK apply button redirects to a third-party ATS, `applyToJob` in seek.ts (lines ~722–738) catches the new tab, sees a non-SEEK URL, calls `captureAndAnalyze(applyPage, 'redirected_to_external_ats', ctx)`, closes the tab, and returns `{ success: false, skipReason: 'redirected_to_external_ats' }`. 365 jobs have been skipped this way.

Phase 5 replaces that early-return with a dispatch to a new ATS engine: detect the provider from the URL, route to a per-provider handler, fill the common fields, and submit. Each handler returns a structured `ATSResult` that `applyToJob` maps onto the existing `ApplyResult`.

This phase also fixes the location-filter bug (hybrid roles outside NSW/QLD are being applied to) — see §1.7.

### 1.1 ATS provider detection

Create `lib/ats/detect.ts`:

```ts
export type ATSProvider =
  | 'workday'
  | 'cornerstone'   // CSOD
  | 'jobadder'
  | 'teamtailor'
  | 'pageup'
  | 'dayforce'
  | 'successfactors'
  | 'taleo'
  | 'smartrecruiters'
  | 'randstad';

// Ordered list of [substring, provider]. First match wins.
// Substrings are matched against the full lower-cased URL.
const ATS_PATTERNS: Array<[string, ATSProvider]> = [
  ['myworkdayjobs.com',   'workday'],
  ['myworkdaysite.com',   'workday'],
  ['.wd1.', 'workday'], ['.wd3.', 'workday'], ['.wd5.', 'workday'],
  ['.wd105.', 'workday'], ['wd3.myworkdayjobs', 'workday'],
  ['csod.com',            'cornerstone'],
  ['apply.jobadder.com',  'jobadder'],
  ['jobadder.com',        'jobadder'],
  ['teamtailor.com',      'teamtailor'],
  ['pageuppeople.com',    'pageup'],
  ['applr.io',            'pageup'],   // PageUp's apply subdomain
  ['dayforcehcm.com',     'dayforce'],
  ['successfactors.com',  'successfactors'],
  ['taleo.net',           'taleo'],
  ['smartrecruiters.com', 'smartrecruiters'],
  ['randstad.com',        'randstad'],
];

export function detectATS(url: string): ATSProvider | null {
  const u = url.toLowerCase();
  for (const [needle, provider] of ATS_PATTERNS) {
    if (u.includes(needle)) return provider;
  }
  return null;
}
```

Notes:
- Workday hostnames vary by tenant (`cba.wd3.myworkdayjobs.com`, `nine.wd105.myworkdayjobs.com`, `stryker.wd1.myworkdayjobs.com`, `wd105.myworkdaysite.com`). Matching on `myworkdayjobs.com` / `myworkdaysite.com` covers all of them; the `.wdN.` patterns are belt-and-suspenders for any odd host.
- Cornerstone tenants are `gsb.csod.com`, `nswconnect.csod.com` — `csod.com` covers both.
- Match order matters only where one substring could be a prefix of another; current list has no such overlap, so order is for readability.

### 1.2 Priority order

Implement in this order (volume-ranked, SmartRecruiters explicitly excluded because it blocks headless browsers — see §1.4.7):

| Order | Provider | Skips | Why |
|---|---|---|---|
| 1 | Workday | 30+29+5+5 = 69 | Highest combined volume; uniform multi-tenant form. |
| 2 | Cornerstone (CSOD) | 21+17 = 38 | Single form layout across tenants. |
| 3 | JobAdder | 33 | Single-page form, simplest of the set. |
| 4 | Teamtailor | 33 | Single-page form, modern markup. |
| 5 | PageUp | 15+10 = 25 | Two flavours (`applr.io`, `pageuppeople.com`) but shared form. |
| 6+ | Dayforce (14), SuccessFactors (10), Taleo (7), Randstad (12) | — | Lower priority; stub handlers that return `skipReason: 'ats_not_implemented'` until tackled. |
| never | SmartRecruiters (58) | — | Blocks bots. Keep a stub that returns `skipReason: 'ats_blocks_bots'`. |

A coder finishing the top 5 has covered ~193 of the 365 skips. Ship the top 5; stub the rest.

### 1.3 Common ATS form-fill strategy

Every ATS apply form needs the same core fields. Create `lib/ats/common.ts` holding shared helpers and the candidate's structured contact data (the existing `CANDIDATE_PROFILE` in seek.ts is a free-text blob meant for the AI — for ATS forms we need discrete fields).

Add a structured profile constant (keep it next to the existing one or export from `lib/ats/common.ts` and re-import into seek.ts so there is a single source of truth):

```ts
export const ATS_CONTACT = {
  firstName: 'Rumman',
  lastName: 'Riyaz',
  fullName: 'Rumman Riyaz',
  email: process.env.SEEK_EMAIL ?? 'mohdrumman1@gmail.com',
  phone: process.env.CANDIDATE_PHONE ?? '',   // add CANDIDATE_PHONE to .env / secrets
  city: 'Newcastle',
  state: 'NSW',
  country: 'Australia',
  postcode: '2300',
  linkedin: process.env.CANDIDATE_LINKEDIN ?? '',
};
```

Add `CANDIDATE_PHONE` and `CANDIDATE_LINKEDIN` to `.env.example`, `.env`, and the workflow's `Create .env from secrets` step + `env:` block. Phone is required by almost every ATS; without it most submits will fail validation.

Common fields and the order they appear:
1. **Resume upload** — every ATS wants a file. Reuse the base resume DOCX/PDF. The tailored DOCX path produced by `generateTailoredDocx` (already called in seek.ts) can be passed into the handler. Provide a generic file-upload helper:

```ts
// lib/ats/common.ts
export async function uploadResumeFile(page: Page, filePath: string): Promise<boolean> {
  const input = page.locator('input[type="file"]').first();
  // Many ATS hide the input behind a styled button; setInputFiles works on hidden inputs.
  if ((await input.count()) === 0) return false;
  try {
    await input.setInputFiles(filePath);
    await page.waitForTimeout(2_000);
    return true;
  } catch (err) {
    logger.warn('ats: resume upload failed', { error: String(err) });
    return false;
  }
}
```
This mirrors `uploadTailoredResume` in `lib/resume-manager.ts`; do NOT reuse that one directly because it has SEEK-specific radio selectors (`input[name="resume-method"]`).

2. **Name / email / phone** — label-driven fill. Reuse the existing `getQuestionLabel(page, locator)` from seek.ts. Extract `getQuestionLabel` and `fillFieldByLabel` into `lib/ats/common.ts` (or a small shared `lib/form-utils.ts`) and import them in both seek.ts and the ATS handlers so the proven label-matching logic is reused, not duplicated. A `fillByLabelHints` helper that takes an array of regex hints per field:

```ts
export async function fillTextByHints(
  page: Page, hints: RegExp[], value: string,
): Promise<boolean> {
  if (!value) return false;
  for (const inp of await page.locator('input[type="text"], input[type="email"], input[type="tel"], input:not([type])').all()) {
    if (!(await inp.isVisible().catch(() => false))) continue;
    if (await inp.inputValue().catch(() => '')) continue; // skip pre-filled
    const label = (await getQuestionLabel(page, inp).catch(() => '')) +
                  ' ' + (await inp.getAttribute('name').catch(() => '') ?? '') +
                  ' ' + (await inp.getAttribute('id').catch(() => '') ?? '');
    if (hints.some((h) => h.test(label))) {
      await inp.fill(value).catch(() => {});
      return true;
    }
  }
  return false;
}
```
Field hint sets (reuse across handlers):
- firstName: `[/first ?name/i, /given name/i]`
- lastName: `[/last ?name/i, /surname/i, /family name/i]`
- fullName: `[/full name/i, /^name$/i, /your name/i]`
- email: `[/e-?mail/i]`
- phone: `[/phone/i, /mobile/i, /contact number/i, /telephone/i]`
- city: `[/city/i, /suburb/i, /town/i]`
- postcode: `[/post ?code/i, /zip/i]`
- linkedin: `[/linkedin/i]`

3. **Cover letter** — optional on most ATS. If a textarea labelled `/cover ?letter/i` or `/message/i` exists, fill the tailored cover letter (already produced in seek.ts via `tailorCoverLetter`). Pass it into the handler.

4. **Employer questions** — most ATS embed custom screening questions. These mirror SEEK's. Reuse the AI-answer path: `findKBAnswer` → `aiAnswerQuestion` / `aiAnswerCheckboxes` from `lib/questions-kb.ts`, exactly as `answerEmployerQuestions` in seek.ts does. Extract a provider-agnostic `answerGenericQuestions(page, kb)` into `lib/ats/common.ts` derived from seek.ts's `answerEmployerQuestions` (it is already mostly selector-generic: `select`, `textarea`, `input`, radio groups by `name`, checkbox groups by `name`). Keep seek.ts's copy as-is for now; create the generic copy in common.ts. (A later refactor can de-duplicate — note it in `KNOWN_FIXES` if you do.)

### 1.4 Per-ATS specifics

Each handler lives in its own file under `lib/ats/` and exports a single function:

```ts
// signature for every handler
export async function applyWorkday(
  page: Page,            // the already-open tab on the ATS URL
  details: JobDetails,
  config: ApplyConfig,
  resumePath: string | null,   // tailored DOCX path, or null → use base resume
  coverLetter: string,
): Promise<ATSResult>;
```

`ATSResult` (define in `lib/ats/types.ts`):
```ts
export interface ATSResult {
  status: 'applied' | 'skipped' | 'failed' | 'needs_manual_review';
  reason?: string;   // skip/failure reason string
}
```

#### 1.4.1 Workday (`lib/ats/workday.ts`) — priority 1

Reaching the form:
- Workday job pages have an "Apply" button (`[data-automation-id="adventureButton"]` or button text "Apply"). Click it.
- Workday almost always requires account creation / sign-in: a modal offers "Apply Manually", "Use My Last Application", "Autofill with Resume", and "Sign In". **Account creation is out of scope and risky.** Strategy: if a sign-in/account wall appears (`[data-automation-id="signInLink"]`, `[data-automation-id="createAccountLink"]`, or text "Create Account" / "Sign In"), return `{ status: 'skipped', reason: 'ats_requires_account' }`. Only proceed if Workday offers a guest "Apply Manually" path with no account.
- Realistically most Workday tenants force account creation, so this handler will skip a large fraction. That is acceptable — log it clearly. Workday is priority 1 by *volume of attempts*, but expect a high skip rate; the value is in the tenants that allow guest apply.

Selectors (Workday uses stable `data-automation-id` attributes — prefer these over CSS classes):
- Apply button: `[data-automation-id="adventureButton"]`, fallback `button:has-text("Apply")`
- "Apply Manually": `[data-automation-id="applyManually"]`, fallback `a:has-text("Apply Manually")`
- First name: `[data-automation-id="legalNameSection_firstName"]`
- Last name: `[data-automation-id="legalNameSection_lastName"]`
- Email: `[data-automation-id="email"]` or `input[type="email"]`
- Phone: `[data-automation-id="phone-number"]`
- Resume upload: `[data-automation-id="file-upload-input-ref"]` (hidden `input[type=file]`)
- Continue / Next: `[data-automation-id="bottom-navigation-next-button"]` or `button:has-text("Next")`, `button:has-text("Save and Continue")`
- Submit: `[data-automation-id="bottom-navigation-next-button"]` on the final review page, or `button:has-text("Submit")`

Cookie banner: Workday shows OneTrust — accept via `#onetrust-accept-btn-handler` (try at handler start; ignore if absent).

Success detection: URL contains `/successfullySubmitted` or a confirmation heading `text=Thank you` / `text=successfully submitted` / `[data-automation-id="confirmationPage"]`.

Gotchas:
- Workday is a multi-page wizard (My Information → My Experience → Application Questions → Voluntary Disclosures → Review). Loop the same way seek.ts does (`for attempt < 6`): fill visible fields, answer questions, click Next, check for success/validation each iteration.
- Voluntary disclosure pages (gender, race, veteran/disability) — leave blank or select "I prefer not to answer". Never auto-fill demographic fields beyond "prefer not to say". These are NOT manual-review triggers (they are optional), but do not guess.

#### 1.4.2 Cornerstone / CSOD (`lib/ats/cornerstone.ts`) — priority 2

Reaching the form:
- CSOD URL is the apply page directly. Look for an "Apply" / "Apply for this job" button (`a:has-text("Apply")`, `button:has-text("Apply")`). Some tenants gate behind "Apply with resume" vs "Apply manually".
- CSOD may offer "Apply with LinkedIn" / "Apply with Seek" / Indeed — ignore those, find the manual/email path.

Selectors (CSOD markup is less stable than Workday; use label hints via `fillTextByHints`):
- Resume upload: `input[type="file"]`
- Name/email/phone: label-driven (`fillTextByHints` with the standard hint sets).
- Continue/Next: `button:has-text("Next")`, `button:has-text("Continue")`, `input[type="submit"][value*="Next" i]`
- Submit: `button:has-text("Submit")`, `#btnSubmit`, `input[value*="Submit" i]`

Cookie banner: often a generic `button:has-text("Accept")` / `#onetrust-accept-btn-handler`.

Success detection: text `Thank you for applying` / `Application submitted` / URL contains `Confirmation`.

Gotchas:
- CSOD frequently embeds the form in an `<iframe>`. At handler start, check for an iframe whose `src` includes `csod.com`; if present, run all locators against `page.frameLocator('iframe[src*="csod.com"]')`. Detect the iframe first; if absent, run against `page` directly. Write the handler to accept a `root: Page | FrameLocator` so the same code path works either way.
- Some CSOD tenants require account creation → return `skipped / ats_requires_account`.

#### 1.4.3 JobAdder (`lib/ats/jobadder.ts`) — priority 3

Reaching the form:
- `apply.jobadder.com` loads the application form directly — usually a single page, no apply button to click.

Selectors:
- First name: `input[name="firstName"]`, fallback hint `/first name/i`
- Last name: `input[name="lastName"]`, fallback hint `/last name/i`
- Email: `input[name="email"]`, `input[type="email"]`
- Phone: `input[name="phone"]`, `input[type="tel"]`
- Resume upload: `input[type="file"]`
- Submit: `button[type="submit"]`, `button:has-text("Submit application")`, `button:has-text("Apply")`

Cookie banner: usually none. If present, generic accept.

Success detection: text `Thank you` / `application has been` / `successfully` / form replaced by confirmation message. JobAdder typically swaps the form for an inline "Thank you for your application" block on the same URL — check for that text after submit.

Gotchas:
- JobAdder may have a Cloudflare Turnstile / reCAPTCHA on submit. If after clicking Submit a captcha widget is visible (`iframe[src*="recaptcha"]`, `iframe[src*="turnstile"]`, `iframe[src*="hcaptcha"]`) and no success appears within the retry window, return `{ status: 'needs_manual_review', reason: 'ats_captcha' }`. Do NOT attempt to solve captchas anywhere in this codebase.
- Required custom questions render as standard `select`/`input` — handled by `answerGenericQuestions`.

#### 1.4.4 Teamtailor (`lib/ats/teamtailor.ts`) — priority 4

Reaching the form:
- `*.teamtailor.com` job page has an "Apply for this job" button: `a:has-text("Apply for")`, `[data-controller*="apply"]`, or `a[href*="/applications/new"]`. Click it to reach the form (often same page, anchored).

Selectors:
- Name: `input[name="candidate[name]"]` (Teamtailor uses a single full-name field), fallback hint `/name/i`
- Email: `input[name="candidate[email]"]`, `input[type="email"]`
- Phone: `input[name="candidate[phone]"]`, `input[type="tel"]`
- Resume upload: `input[type="file"][name*="resume" i]` or first `input[type="file"]`
- Cover letter: `textarea[name*="cover" i]`, `textarea[name="candidate[cover_letter]"]`
- Submit: `button[type="submit"]`, `button:has-text("Send application")`, `button:has-text("Submit")`

Cookie banner: Teamtailor's own consent — `button:has-text("Accept")`, `[data-cookie-consent] button`. Also OneTrust on some accounts.

Success detection: redirect to a `/confirmation` or thank-you page; text `Thanks for applying` / `Your application has been sent`.

Gotchas:
- GDPR consent checkbox is usually **required** to submit (`input[type="checkbox"]` near "I agree" / "consent to store"). This is a legitimate consent the candidate must give to apply — tick it. (Distinct from the §1.6 safety rule: ticking a privacy-consent box to submit an application is expected and allowed; collecting TFN/passport/etc. is not.)
- Teamtailor uploads can take a few seconds to show a preview — wait after `setInputFiles`.

#### 1.4.5 PageUp (`lib/ats/pageup.ts`) — priority 5

Reaching the form:
- Two host flavours: `applr.io` (newer SPA) and `secure.dc2.pageuppeople.com` (classic). Detect which by hostname inside the handler.
- Classic PageUp: an "Apply" / "Begin" button leads to a multi-step form, often gated by account creation. If account creation is forced → `skipped / ats_requires_account`.
- `applr.io`: more likely to allow guest apply with resume upload.

Selectors (label-driven via `fillTextByHints` — PageUp markup is tenant-themed and unstable):
- Resume upload: `input[type="file"]`
- Name/email/phone: hint-driven.
- Continue/Next: `button:has-text("Next")`, `button:has-text("Continue")`, `#nextButton`
- Submit: `button:has-text("Submit")`, `#submitButton`, `input[value*="Submit" i]`

Cookie banner: generic accept / OneTrust.

Success detection: text `application has been received` / `Thank you` / URL contains `Confirmation` or `applicationsubmitted`.

Gotchas:
- Classic PageUp often has a mandatory "Personal Details" + "Questionnaire" + "Documents" multi-page flow → loop like Workday.
- Date-of-birth and "Right to work — provide visa details" fields appear on some tenants → see §1.6 safety.

#### 1.4.6 Stubs (`lib/ats/dayforce.ts`, `successfactors.ts`, `taleo.ts`, `randstad.ts`)

Each exports a handler matching the standard signature that immediately returns:
```ts
return { status: 'skipped', reason: 'ats_not_implemented' };
```
This keeps the dispatcher total (no `null` handler) and records a clean skip reason for analytics, so we can later see how many we are leaving on the table.

#### 1.4.7 SmartRecruiters (`lib/ats/smartrecruiters.ts`)

SR blocks headless Chromium (datacenter IPs + fingerprinting). Do not attempt in CI. However, running locally in headed mode from a residential IP is very likely to bypass SR's block — so instead of just skipping, **queue SR jobs for local processing**.

The stub handler should:
1. Return `{ status: 'skipped', reason: 'ats_queued_sr' }` — not `ats_blocks_bots`.
2. Before returning, append the job to `data/sr-queue.json`:

```ts
// lib/ats/smartrecruiters.ts
export async function applySmartRecruiters(
  page: Page, details: JobDetails, config: ApplyConfig,
  resumePath: string | null, coverLetter: string,
): Promise<ATSResult> {
  const entry = {
    jobId: page.url().match(/\d{5,}/)?.[0] ?? Date.now().toString(),
    title: details.title,
    company: details.company,
    location: details.location,
    externalUrl: page.url(),
    queuedAt: new Date().toISOString(),
    done: false,
  };
  const queuePath = path.resolve(__dirname, '../../data/sr-queue.json');
  const queue = fs.existsSync(queuePath) ? JSON.parse(fs.readFileSync(queuePath, 'utf8')) : [];
  // Don't add duplicates
  if (!queue.some((q: typeof entry) => q.jobId === entry.jobId)) {
    queue.push(entry);
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
    logger.info('ats: SR job queued for local run', { title: details.title, company: details.company });
  }
  return { status: 'skipped', reason: 'ats_queued_sr' };
}
```

Add an `npm run seek-sr` script to `package.json` pointing to a new `scripts/seek-sr.ts`:
- Reads `data/sr-queue.json`, filters `done: false` entries.
- For each entry, runs the full `applyToSingleUrl` pipeline (headed browser, full resume tailoring, form fill, KB answers) against `entry.externalUrl` (the SR URL directly, not the SEEK job page).
- On success or skip, marks `done: true` and saves the queue.
- User watches the headed browser and can intervene if SR throws a CAPTCHA.

This way CI auto-collects SR jobs and the user drains the queue locally with one command when convenient.

### 1.5 Code structure & wiring

Directory layout:
```
lib/ats/
  index.ts          ← applyViaATS dispatcher + re-exports
  types.ts          ← ATSResult, ATSProvider re-export
  detect.ts         ← detectATS()
  common.ts         ← ATS_CONTACT, uploadResumeFile, fillTextByHints,
                       getQuestionLabel (shared), answerGenericQuestions
  workday.ts
  cornerstone.ts
  jobadder.ts
  teamtailor.ts
  pageup.ts
  dayforce.ts        (stub)
  successfactors.ts  (stub)
  taleo.ts           (stub)
  randstad.ts        (stub)
  smartrecruiters.ts (stub)
```

`lib/ats/index.ts` — the single entry point seek.ts calls:
```ts
import { Page } from '@playwright/test';
import { JobDetails, ApplyConfig } from '../platforms/types';
import { detectATS } from './detect';
import { ATSResult } from './types';
import { applyWorkday } from './workday';
// ...imports for each handler

const HANDLERS: Record<ATSProvider, Handler> = {
  workday: applyWorkday,
  cornerstone: applyCornerstone,
  jobadder: applyJobAdder,
  teamtailor: applyTeamtailor,
  pageup: applyPageUp,
  dayforce: applyDayforce,
  successfactors: applySuccessFactors,
  taleo: applyTaleo,
  randstad: applyRandstad,
  smartrecruiters: applySmartRecruiters,
};

export async function applyViaATS(
  page: Page,
  url: string,
  details: JobDetails,
  config: ApplyConfig,
  resumePath: string | null,
  coverLetter: string,
): Promise<{ result: ATSResult; provider: ATSProvider | null }> {
  const provider = detectATS(url);
  if (!provider) {
    return { result: { status: 'skipped', reason: 'ats_unknown_provider' }, provider: null };
  }
  logger.info('ats: routing', { provider, url: url.slice(0, 80) });
  try {
    const result = await HANDLERS[provider](page, details, config, resumePath, coverLetter);
    return { result, provider };
  } catch (err) {
    logger.error('ats: handler threw', { provider }, err);
    await captureAndAnalyze(page, `ats_${provider}_error`, { job_title: details.title, company: details.company });
    return { result: { status: 'failed', reason: `ats_${provider}_error` }, provider };
  }
}
```

Wiring into seek.ts `applyToJob` — replace the early-return at lines ~732–738:

Current:
```ts
const isSeekUrl = applyPage.url().includes('seek.com.au') || applyPage.url().includes('au.seek.com');
if (!isSeekUrl) {
  console.log(`  Skipping - Apply redirected to external: ${applyPage.url().slice(0, 60)}`);
  await captureAndAnalyze(applyPage, 'redirected_to_external_ats', ctx);
  if (newPage) await newPage.close().catch(() => {});
  return { success: false, skipReason: 'redirected_to_external_ats' };
}
```

New:
```ts
const isSeekUrl = applyPage.url().includes('seek.com.au') || applyPage.url().includes('au.seek.com');
if (!isSeekUrl) {
  const externalUrl = applyPage.url();
  // Build resume + cover letter the same way the SEEK path does, so the ATS
  // handler gets the tailored DOCX when tailoring is enabled.
  const coverLetter = await tailorCoverLetter(config.baseCoverLetter, details.title, details.company, details.description);
  let resumePath: string | null = null;
  if (process.env.RESUME_TAILORING_ENABLED === 'true') {
    const variant = resolveResumeVariant(details.title, config.searchName) ?? config.resumeVariant;
    const jobId = externalUrl.match(/(\d{5,})/)?.[1] ?? Date.now().toString();
    const tailored = await tailorResume(variant, details.title, details.company, details.description, externalUrl);
    if (tailored) {
      resumePath = await generateTailoredDocx(tailored, jobId, details.company).catch(() => null);
    }
  }
  // resumePath may be null → handlers fall back to a base resume file on disk
  // (see note below) or skip resume upload if none is configured.

  const { result, provider } = await applyViaATS(applyPage, externalUrl, details, config, resumePath, coverLetter);
  if (newPage) await newPage.close().catch(() => {});

  // Map ATSResult → ApplyResult, attaching ats metadata for the tracker.
  const atsMeta = { atsProvider: provider ?? undefined, externalUrl };
  if (result.status === 'applied')             return { success: true,  variant: config.resumeVariant, ...atsMeta };
  if (result.status === 'needs_manual_review') return { success: false, failureReason: result.reason, requiresManualReview: true, ...atsMeta };
  if (result.status === 'failed')              return { success: false, failureReason: result.reason ?? 'ats_failed', ...atsMeta };
  return { success: false, skipReason: result.reason ?? 'redirected_to_external_ats', ...atsMeta };
}
```

Base-resume fallback: when `resumePath` is null, handlers should upload a known base resume. Add a `getBaseResumePath(variant)` helper to `lib/ats/common.ts` that resolves a file under `data/resumes/` (inspect that directory for the actual filenames — e.g. `pm.docx`, `se.docx`). If no base file exists, skip the upload step (some ATS accept profile-only submissions; many will then fail validation and return `ats_missing_resume`).

Extend `ApplyResult` in types.ts:
```ts
export interface ApplyResult {
  success: boolean;
  variant?: ResumeVariant;
  skipReason?: string;
  failureReason?: string;
  requiresManualReview?: boolean;
  atsProvider?: string;   // NEW
  externalUrl?: string;   // NEW
}
```

### 1.6 Safety — fields that trigger `needs_manual_review`

Reuse the existing manual-review pattern: set `requiresManualReview: true` on the result (the tracker already writes a `requires_manual_review` column — see `recordFailure` in tracker.ts).

In `lib/ats/common.ts`, add a guard run at the start of question-answering and again before any submit:
```ts
const SENSITIVE_RE = /\b(tax file number|\bTFN\b|passport (number|no)|date of birth|\bDOB\b|bank (account|details|bsb)|\bBSB\b|account number|medicare|driver'?s licence number|superannuation (fund|member) number|visa (grant|subclass) number)\b/i;

export async function hasSensitiveRequiredField(page: Page): Promise<string | null> {
  // Scan visible labels of required inputs/selects. Return the matched label, or null.
  for (const el of await page.locator('input, select, textarea').all()) {
    if (!(await el.isVisible().catch(() => false))) continue;
    const required = (await el.getAttribute('required').catch(() => null)) !== null ||
                     (await el.getAttribute('aria-required').catch(() => null)) === 'true';
    const label = await getQuestionLabel(page, el).catch(() => '');
    if (SENSITIVE_RE.test(label)) {
      if (required) return label.trim();   // hard stop only if required
    }
  }
  return null;
}
```
In each handler: before submitting, call `hasSensitiveRequiredField(page)`. If it returns a label, abort with `{ status: 'needs_manual_review', reason: 'sensitive_field:' + label.slice(0, 60) }`. Never fill TFN/passport/DOB/bank fields. Non-required sensitive fields are left blank.

Demographic voluntary-disclosure fields (gender/race/veteran/disability) are NOT sensitive-stop fields — they are optional; leave blank or "prefer not to answer". Do not stop the application for them.

### 1.7 Location filter fix

Add to seek.ts (above the `SeekPlatform` class, near the other utilities):

```ts
// Remote roles: any location OK. Hybrid roles: must be NSW or QLD (candidate
// will not commute to an office in VIC/WA/SA/ACT/TAS). On-site: NSW/QLD only too.
function filterByLocation(details: JobDetails): { ok: boolean; reason?: string } {
  const text = `${details.location} ${details.workType} ${details.title}`.toLowerCase();
  const isRemote = /\bremote\b/.test(text) && !/hybrid/.test(text);
  if (isRemote) return { ok: true };

  // Hybrid or on-site: require NSW or QLD signal in the location.
  const loc = details.location.toLowerCase();
  const allowed = /\b(nsw|new south wales|sydney|newcastle|wollongong|qld|queensland|brisbane|gold coast|sunshine coast)\b/.test(loc);
  const blocked = /\b(vic|victoria|melbourne|wa|western australia|perth|sa|south australia|adelaide|act|canberra|tas|tasmania|hobart|nt|northern territory|darwin)\b/.test(loc);
  if (allowed && !blocked) return { ok: true };
  if (blocked) return { ok: false, reason: 'location_out_of_region' };
  // No clear state signal — allow (SEEK search already filters; avoid false negatives).
  return { ok: true };
}
```

Call it as the FIRST check inside `applyToJob`, before the external-apply check (so it short-circuits both SEEK-native and ATS paths):
```ts
async applyToJob(page, context, details, config): Promise<ApplyResult> {
  const ctx = { job_title: details.title, company: details.company };

  const locCheck = filterByLocation(details);   // ← ADD THIS FIRST
  if (!locCheck.ok) {
    console.log(`  Skipping - ${locCheck.reason}: ${details.location}`);
    logger.info('skip: location out of region', { location: details.location, workType: details.workType, title: details.title });
    return { success: false, skipReason: locCheck.reason };
  }

  // ...existing external-apply check follows
}
```
Rationale for the "no clear state signal → allow" branch: the SEEK search URLs already filter `workarrangement=2,3` and the description scrape isn't always reliable for state. The blocklist is the hard guard; matching an explicit VIC/WA/etc. signal is what was missing.

### 1.8 Tracking

Two new optional columns. Update `lib/tracker.ts`:
- Add `ats_provider` and `external_url` to `APP_HEADERS`, `SKIP_HEADERS`, and `FAIL_HEADERS` (append at the end so existing CSV columns keep their positions; new rows get the values, old rows render empty for those columns).
- Extend `JobMeta` (or accept extra fields on each record function) with `atsProvider?: string; externalUrl?: string;` and write them in `recordApplication`/`recordSkip`/`recordFailure`.
- In apply.ts, the `jobMeta` object built around line ~231 must pass `atsProvider: result.atsProvider` and `externalUrl: result.externalUrl` through. Same for the single-URL path (apply.ts ~103).

New skip/failure reason strings introduced (for the analyze step / dashboards): `ats_requires_account`, `ats_not_implemented`, `ats_blocks_bots`, `ats_unknown_provider`, `ats_captcha`, `ats_missing_resume`, `ats_<provider>_error`, `sensitive_field:<label>`, `location_out_of_region`.

### 1.9 Error handling

- On any handler exception, the dispatcher (§1.5) already calls `captureAndAnalyze(page, 'ats_<provider>_error', ctx)` — same screenshot + AI-analysis pattern as the SEEK native path.
- Inside each handler, when the submit cannot be reached after the retry loop, call `captureAndAnalyze(page, 'ats_<provider>_no_submit', ctx)` before returning `failed`.
- Add `KNOWN_FIXES` entries in `lib/error-analyzer.ts` as ATS issues are diagnosed (per the repo's running error-log convention). At minimum add a stub entry for each `ats_<provider>_error` once the first real failure is analysed, documenting the selector that broke.
- Per CLAUDE.md: log significant ATS bugs to `KNOWN_FIXES` and a `project_ats_<provider>.md` memory file when a fix is non-obvious.

### 1.10 Suggested implementation sequence for the coder

1. types.ts (`ApplyResult` fields) + tracker.ts columns + apply.ts pass-through. Compile.
2. `lib/ats/detect.ts` + `lib/ats/types.ts` + a unit-style smoke test of `detectATS` against the 16 hostnames in the skip list.
3. `lib/ats/common.ts` (extract shared helpers; do not break seek.ts).
4. `lib/ats/index.ts` dispatcher with ALL handlers as stubs first. Wire into seek.ts. Confirm a real external-redirect job now logs `ats: routing` and records the new columns.
5. Location filter fix (§1.7) — independent, ship it early.
6. Implement handlers in priority order: JobAdder and Teamtailor first (simplest single-page forms, fastest wins), then Cornerstone, then Workday and PageUp (multi-page wizards).
7. Add `CANDIDATE_PHONE` / `CANDIDATE_LINKEDIN` to .env files and the workflow.

---

## Section 2: Phase 7 — On-Demand Single-Job Apply

### 2.0 Goal

Let Rumman paste a single SEEK job URL into the GitHub Actions UI and have the bot apply to just that one job. The runtime support already exists — `applyToSingleUrl()` in apply.ts and the `--url` CLI flag are implemented and working. **The only work is wiring a `workflow_dispatch` input through to the npm command, plus a small URL normaliser.** Intentionally minimal — no new infrastructure.

### 2.1 GitHub Actions trigger

In `.github/workflows/seek-apply.yml`, replace the bare `workflow_dispatch:` (line 9) with an inputs block:

```yaml
  workflow_dispatch:
    inputs:
      job_url:
        description: 'SEEK job URL to apply to (leave blank to run the normal search loop)'
        required: false
        type: string
      dry_run:
        description: 'Dry run (fill but do not submit)'
        required: false
        type: boolean
        default: false
```

Add the `dry_run` toggle too — it costs nothing and makes single-job mode safe to test before committing to a live submit.

Pass the input to the bot. The `Run bot` step (currently line ~64–70) becomes:

```yaml
      - name: Run bot
        id: bot
        shell: bash -eo pipefail {0}
        env:
          JOB_URL: ${{ github.event.inputs.job_url }}
          DRY_RUN_INPUT: ${{ github.event.inputs.dry_run }}
        run: |
          ARGS=""
          if [ -n "$JOB_URL" ]; then
            NORMALISED="$(node scripts/normalise-url.js "$JOB_URL")"
            echo "Single-job mode for: $NORMALISED"
            ARGS="--url $NORMALISED"
          fi
          if [ "$DRY_RUN_INPUT" = "true" ]; then
            ARGS="$ARGS --dry-run"
          fi
          npm run seek -- $ARGS 2>&1 | tee tmp/bot.log
```

Notes:
- `npm run seek -- $ARGS` forwards flags to `scripts/apply.ts` (the `seek` script is `ts-node scripts/apply.ts --platform seek`; the `--` passes additional argv). `parseArgs()` in apply.ts already reads `--url` and `--dry-run`.
- When `job_url` is empty (scheduled runs, or a manual dispatch with no URL), `ARGS` stays empty and the normal search loop runs unchanged. Existing scheduled behaviour is untouched.
- `github.event.inputs.*` is empty string on `schedule` events, so the `-n "$JOB_URL"` guard correctly falls through to normal mode.

### 2.2 URL normalisation

SEEK URLs come in several shapes:
- `https://www.seek.com.au/job/12345678`
- `https://seek.com.au/job/12345678`
- `https://au.seek.com/job/12345678` (mobile/app share links)
- with tracking query params: `...?type=standout&ref=...`
- occasionally just the bare job id pasted by the user.

`applyToSingleUrl` does `page.goto(url)` then `getJobDetails`, and the job-id extraction regex used by the tracker is `/\/job\/(\d+)/`. Normalise to the canonical `https://www.seek.com.au/job/<id>` form so both work reliably.

Create `scripts/normalise-url.js` (plain Node, no ts-node needed in the shell step — keep it dependency-free so it runs with `node` directly):

```js
// Usage: node scripts/normalise-url.js "<seek url or job id>"
// Prints the canonical https://www.seek.com.au/job/<id> URL to stdout.
const input = (process.argv[2] || '').trim();

function normalise(raw) {
  if (!raw) return '';
  // Bare numeric id
  if (/^\d{5,}$/.test(raw)) return `https://www.seek.com.au/job/${raw}`;
  // Try to pull a /job/<id> segment from any SEEK host variant
  const m = raw.match(/\/job\/(\d+)/);
  if (m) return `https://www.seek.com.au/job/${m[1]}`;
  // Fall back: strip query/hash, rewrite host variants to www.seek.com.au
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    u.search = '';
    u.hash = '';
    if (/^(au\.seek\.com|seek\.com\.au|www\.seek\.com\.au)$/i.test(u.hostname)) {
      u.hostname = 'www.seek.com.au';
    }
    return u.toString();
  } catch {
    return raw; // last resort: hand back unchanged, let page.goto try
  }
}

process.stdout.write(normalise(input));
```

Why a separate `.js` script rather than normalising inside apply.ts: the workflow needs to echo the normalised URL into the log *before* launching the (slow) ts-node process, and a plain `node` one-liner is cheaper and easier to read in YAML. apply.ts's `parseArgs` can stay exactly as-is. (Optional belt-and-suspenders: also call the same normalise function inside `applyToSingleUrl` so local `--url` runs benefit — if you do, factor `normalise` into a tiny `lib/url-utils.ts` and import it in both places. Not required for the MVP.)

### 2.3 How single-URL mode already works (no changes needed)

For reference — this is already built in apply.ts (lines 75–112, 173–177):
- `parseArgs()` reads `--url` into `opts.singleUrl`.
- In `main()`, after `loginAndVerify` + `persistSession`, if `opts.singleUrl` is set it calls `applyToSingleUrl(...)` and returns, skipping the search loop entirely.
- `applyToSingleUrl` navigates to the URL, scrapes `getJobDetails`, calls `platform.applyToJob`, prints the outcome, and records to the tracker (application / skip / failure) unless `--dry-run`.
- It defaults `resumeVariant` to `'pm'`, but `applyToJob` internally calls `resolveResumeVariant(details.title, ...)` so the correct variant is still chosen from the scraped title.

### 2.4 UX — what the Actions log shows

Rumman needs to confirm the application went through from the run log. The existing `console.log`/`logger` output already provides this; ensure the single-job path surfaces it clearly:
- `Single-job mode for: https://www.seek.com.au/job/<id>` (printed by the workflow step before launch).
- `Single URL mode: <job title>` (printed by `applyToSingleUrl`).
- On success: `  Applied!`
- On non-success: `  Not applied — <skipReason | failureReason>`.

Optional polish (nice-to-have, ~10 min): in `applyToSingleUrl`, after the result, print a one-line summary banner so it is unmissable in the log, e.g.:
```ts
console.log(`\n===== RESULT: ${result.success ? 'APPLIED' : 'NOT APPLIED'} — ${details.title} @ ${details.company} =====\n`);
```
If `result.success` is false and `requiresManualReview` is true, also print the manual-review reason. No GitHub step-summary integration is needed (out of scope), but if desired the workflow could append the last line of `tmp/bot.log` to `$GITHUB_STEP_SUMMARY` — optional.

### 2.5 Scope

In scope:
1. `workflow_dispatch.inputs` block (`job_url`, `dry_run`).
2. Modified `Run bot` step that builds `$ARGS` and forwards them.
3. `scripts/normalise-url.js`.
4. (Optional) summary banner in `applyToSingleUrl`.

Explicitly out of scope: no new tracker fields, no new platform code, no queueing, no multi-URL batch input, no GitHub step-summary integration. Single-job mode reuses the entire existing apply pipeline including resume tailoring and the (Phase 5) ATS engine — a single external-ATS URL will route through `applyViaATS` automatically.

### 2.6 Estimated effort

1–2 hours, including a manual `workflow_dispatch` test run against a known SEEK job URL in `--dry-run` mode first, then a live submit to confirm end-to-end.

### 2.7 Test plan

1. `node scripts/normalise-url.js "https://au.seek.com/job/12345678?ref=foo"` → must print `https://www.seek.com.au/job/12345678`.
2. `node scripts/normalise-url.js "12345678"` → `https://www.seek.com.au/job/12345678`.
3. Dispatch the workflow with a real `job_url` and `dry_run=true`; confirm the log shows the title scrape and "NOT APPLIED" / dry-run behaviour (no CSV write).
4. Dispatch with `dry_run=false`; confirm `Applied!` and a new row in `data/applications.csv`.
5. Dispatch with empty `job_url` (or a scheduled run) → confirm the normal search loop runs unchanged.

---

## Section 3: Phase 10 — CommBank Direct (Workday Careers Portal)

### 3.0 Goal & current state

CBA jobs that appear on SEEK and redirect to `cba.wd3.myworkdayjobs.com` already flow through the Phase 5 Workday handler — `.wd3.` is detected, `applyWorkday` is called, account sign-in/creation is attempted via `WORKDAY_PASSWORD`. **What's missing is the job source**: roles that CBA only posts on their own careers portal, never syndicated to SEEK.

This phase adds a direct scraper for `cba.wd3.myworkdayjobs.com/en-US/CBA_Careers`, feeds the found job URLs into the existing `applyToSingleUrl` pipeline, and wires it up as an isolated GitHub Actions workflow.

### 3.1 New files

```
lib/crawlers/
  types.ts           ← CompanyCrawler interface
  cba.ts             ← CBA Workday job listing scraper
scripts/
  company-apply.ts   ← new entry point (mirrors apply.ts but sources from a company crawler)
.github/workflows/
  cba-apply.yml      ← isolated 3×/day workflow
```

### 3.2 `lib/crawlers/types.ts`

```ts
import { Page } from '@playwright/test';

export interface CrawlerJobLink {
  url: string;      // direct apply URL or listing URL
  title?: string;   // optional: pre-scraped title for logging
  jobId: string;    // dedup key — derived from the URL
}

export interface CompanyCrawler {
  name: string;
  getJobLinks(page: Page): Promise<CrawlerJobLink[]>;
}
```

Keep this thin. The crawler only fetches links; all apply logic, tailoring, and tracking is handled by `applyToSingleUrl` in `apply.ts`.

### 3.3 `lib/crawlers/cba.ts`

CBA's Workday job listing URL with filters applied:

```
https://cba.wd3.myworkdayjobs.com/en-US/CBA_Careers?locations=LOCATION_ID&jobFamilyGroup=FAMILY_ID
```

Workday listings pages are React-rendered SPAs. The simplest scrape approach: load the page, wait for job cards to render, extract links. Don't fight the pagination — Workday listings load incrementally; scroll-to-bottom or use the "Load More" button.

```ts
import { Page } from '@playwright/test';
import { CompanyCrawler, CrawlerJobLink } from './types';
import { logger } from '../logger';

// Target role keywords — checked case-insensitively against job title
const TARGET_KEYWORDS = [
  'project manager', 'technical project manager', 'delivery manager', 'delivery lead',
  'program manager', 'software engineer', 'full stack', 'backend', 'cloud engineer',
  'ai engineer', 'ai consultant', 'solutions architect', 'product owner',
];

// Location terms that indicate NSW/QLD or remote — reject anything explicitly interstate
const LOCATION_ALLOW = /nsw|new south wales|sydney|newcastle|qld|queensland|brisbane|remote|hybrid/i;
const LOCATION_BLOCK = /victoria|melbourne|\bvic\b|western australia|perth|\bwa\b|south australia|adelaide|\bsa\b|canberra|\bact\b|tasmania|darwin|\bnt\b/i;

const CBA_BASE_URL = 'https://cba.wd3.myworkdayjobs.com/en-US/CBA_Careers';

export class CbaCrawler implements CompanyCrawler {
  name = 'cba';

  async getJobLinks(page: Page): Promise<CrawlerJobLink[]> {
    await page.goto(CBA_BASE_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3_000);

    // Scroll + "Load More" loop to surface all listings (Workday lazy-loads in batches)
    for (let i = 0; i < 10; i++) {
      const loadMore = page.locator('button:has-text("Load More"), [data-automation-id="loadMoreButton"]').first();
      if (await loadMore.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await loadMore.click().catch(() => {});
        await page.waitForTimeout(2_000);
      } else {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1_500);
        const stillMore = await loadMore.isVisible({ timeout: 1_000 }).catch(() => false);
        if (!stillMore) break;
      }
    }

    // Job cards link to the detail/listing page, not the apply form directly.
    // Workday listing hrefs look like: /en-US/CBA_Careers/job/Sydney-NSW/Senior-Project-Manager_R-XXXXXX
    const anchors = await page.locator('a[data-automation-id="jobTitle"], a[href*="/CBA_Careers/job/"]').all();
    const results: CrawlerJobLink[] = [];

    for (const a of anchors) {
      const href = await a.getAttribute('href').catch(() => null);
      const title = (await a.textContent().catch(() => '')) ?? '';
      if (!href) continue;

      const abs = new URL(href, CBA_BASE_URL).toString();

      // Title filter — must match at least one target keyword
      const titleLow = title.toLowerCase();
      if (!TARGET_KEYWORDS.some((kw) => titleLow.includes(kw))) continue;

      // Location filter — derive from the URL path which embeds "Sydney-NSW" / "Brisbane-QLD" etc.
      const pathLow = abs.toLowerCase();
      if (LOCATION_BLOCK.test(pathLow) && !LOCATION_ALLOW.test(pathLow)) continue;

      // Derive a stable jobId from the Workday job requisition number in the URL (R-XXXXXXXX)
      const jobId = abs.match(/_(R-[\w]+)\s*$/i)?.[1] ?? abs.match(/\/job\/[^/]+\/[^/]+-([^/]+)$/)?.[1] ?? abs;

      results.push({ url: abs, title: title.trim(), jobId });
    }

    logger.info('cba: job links found', { total: results.length });
    return results;
  }
}
```

Notes:
- The keyword filter runs on the title embedded in the page, not the full JD — fast and avoids a second page load per listing.
- Location filter uses the URL path segment (Workday encodes location in the slug) — fast and reliable. The `filterByLocation` function in seek.ts is for post-scrape filtering; this is a pre-filter to avoid visiting irrelevant listing pages.
- The dedup key (`jobId`) must be stable across runs. Workday requisition IDs (`R-XXXXXXXX`) in the URL slug are stable. Use those; fall back to the last path segment if no `R-` number found.

### 3.4 `scripts/company-apply.ts`

New script. Mirrors `apply.ts` but sources jobs from a `CompanyCrawler` instead of a `JobPlatform` search loop.

```ts
// Usage: ts-node scripts/company-apply.ts --company cba [--dry-run] [--max <n>]
import 'dotenv/config';
import { chromium } from '@playwright/test';
import { CbaCrawler } from '../lib/crawlers/cba';
import { SeekPlatform } from '../lib/platforms/seek';
import { loadKB } from '../lib/questions-kb';
import { logger } from '../lib/logger';
import * as fs from 'fs';
import * as path from 'path';

const CRAWLERS: Record<string, CompanyCrawler> = {
  cba: new CbaCrawler(),
};

// Reuse apply.ts helpers: applyToSingleUrl, loadApplied, saveApplied, etc.
// Import directly from apply.ts is not possible (it's a script, not a module).
// Copy the minimal set here, or extract shared helpers to lib/apply-utils.ts (preferred long-term refactor).
// For the MVP: duplicate the ~50 lines needed; note it in KNOWN_FIXES for future de-dup.
```

**Recommended refactor (do this first before writing company-apply.ts):** Extract `applyToSingleUrl`, `loadApplied`, `saveApplied`, `loadBlocked`, `saveBlocked` from `scripts/apply.ts` into `lib/apply-utils.ts`. Both `apply.ts` and `company-apply.ts` import from there. This is a small extraction — ~100 lines — and avoids duplication. Note the extraction in `KNOWN_FIXES` if any breakage occurs.

Key logic in `company-apply.ts`:

```ts
async function main() {
  const args = process.argv.slice(2);
  const companyName = args[args.indexOf('--company') + 1] ?? 'cba';
  const dryRun = args.includes('--dry-run');
  const maxApps = Number(args[args.indexOf('--max') + 1] ?? process.env.MAX_APPS_PER_RUN ?? 20);

  const crawler = CRAWLERS[companyName];
  if (!crawler) { console.error(`Unknown company: ${companyName}`); process.exit(1); }

  const runId = new Date().toISOString();
  const kb = loadKB();
  const applied = loadApplied();
  const blocked = loadBlocked();

  const browser = await chromium.launch({ headless: process.stdin.isTTY !== true });
  const platform = new SeekPlatform();  // needed for applyToSingleUrl's platform param + Workday auth
  const context = await platform.authenticate(browser);
  const page = await context.newPage();

  // Crawl the company's careers page
  const listingPage = await context.newPage();
  const links = await crawler.getJobLinks(listingPage);
  await listingPage.close();

  logger.info(`${companyName}: found ${links.length} matching job links`);

  let total = 0;
  for (const { url, title, jobId } of links) {
    if (total >= maxApps) break;
    if (applied.has(jobId)) { logger.debug('already applied', { jobId }); continue; }
    if (blocked.has(jobId)) { logger.debug('blocked', { jobId }); continue; }

    logger.info(`${companyName}: applying`, { jobId, title });
    await applyToSingleUrl(platform, page, context, url, kb, baseCoverLetter, dryRun, runId);
    if (!dryRun) { applied.add(jobId); saveApplied(applied); }
    total++;
    await page.waitForTimeout(6_000);
  }

  await browser.close();
  logger.info(`${companyName}: done`, { total });
}
```

Add to `package.json` scripts:
```json
"company": "ts-node scripts/company-apply.ts --platform seek"
```

### 3.5 CBA-specific KB entries

Pre-populate `data/questions_kb.json` with these answers before the first live run. KB entries follow the existing schema (`{ question, answer, source }`).

| Question pattern | Answer | Notes |
|---|---|---|
| `right to work in australia` | `Yes` | Citizen |
| `currently employed by (commbank\|commonwealth bank\|cba)` | `No` | — |
| `previously applied.*commbank` | `No` | Update manually if prior application exists |
| `security clearance` | `No` | Route to `needs_manual_review` if marked required |
| `criminal history.*financial services` | manual review | `hasSensitiveRequiredField` should catch this; add as KB safeguard too |
| `notice period` | `2 weeks` | Standard |
| `salary expectation` | `120000` | Minimum threshold |
| `willing to relocate` | `No` | Newcastle/Sydney/Brisbane preference |

### 3.6 `.github/workflows/cba-apply.yml`

Separate workflow, isolated failure. The SEEK run and CBA run run independently.

```yaml
name: CBA Careers Auto Apply

on:
  schedule:
    - cron: '47 20 * * *'   # 6:47am AEST
    - cron: '47 2 * * *'    # 12:47pm AEST
    - cron: '47 8 * * *'    # 6:47pm AEST
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Dry run — fill but do not submit'
        required: false
        type: boolean
        default: false

concurrency:
  group: cba-apply
  cancel-in-progress: false

jobs:
  apply:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 120
    permissions:
      contents: write

    env:
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
      SEEK_EMAIL: ${{ secrets.SEEK_EMAIL }}
      SEEK_SESSION_COOKIES: ${{ secrets.SEEK_SESSION_COOKIES }}
      CANDIDATE_PHONE: ${{ secrets.CANDIDATE_PHONE }}
      CANDIDATE_LINKEDIN: ${{ secrets.CANDIDATE_LINKEDIN }}
      WORKDAY_PASSWORD: ${{ secrets.WORKDAY_PASSWORD }}
      MAX_APPS_PER_RUN: '20'
      RESUME_TAILORING_ENABLED: 'true'
      DRY_RUN: 'false'
      LOG_LEVEL: 'info'

    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v6
        with:
          node-version: '22'
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - name: Create .env from secrets
        run: |
          {
            echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
            echo "SEEK_EMAIL=${SEEK_EMAIL}"
            echo "CANDIDATE_PHONE=${CANDIDATE_PHONE}"
            echo "CANDIDATE_LINKEDIN=${CANDIDATE_LINKEDIN}"
            echo "WORKDAY_PASSWORD=${WORKDAY_PASSWORD}"
            echo "MAX_APPS_PER_RUN=${MAX_APPS_PER_RUN}"
            echo "RESUME_TAILORING_ENABLED=${RESUME_TAILORING_ENABLED}"
            echo "DRY_RUN=${DRY_RUN}"
          } > .env
      - run: mkdir -p data/sessions tmp
      - name: Run CBA crawler
        shell: bash -eo pipefail {0}
        env:
          DRY_RUN_INPUT: ${{ github.event.inputs.dry_run }}
        run: |
          ARGS="--company cba"
          [ "$DRY_RUN_INPUT" = "true" ] && ARGS="$ARGS --dry-run"
          npm run company -- $ARGS 2>&1 | tee tmp/cba-bot.log
      - name: Commit updated data
        if: success() && github.event.inputs.dry_run != 'true'
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add data/applied_jobs.json data/applications.csv data/skipped_jobs.csv data/failed_jobs.csv || true
          git diff --staged --quiet || git commit -m "bot: update data (cba) [skip ci]"
          git push
```

Note: schedule times are staggered 30 min from the SEEK workflow (6:17am vs 6:47am) so both workflows don't spin up GitHub runners simultaneously and compete for the same `applied_jobs.json` commit.

### 3.7 `applied_jobs.json` concurrency

Both workflows write to `data/applied_jobs.json`. The current design (read → apply → write → commit) is not atomic across two concurrent workflows. Mitigation:
- The schedule times are staggered 30 min; in practice runs rarely overlap
- `concurrency: group: cba-apply` / `group: seek-apply` prevent two instances of the same workflow running simultaneously
- Cross-workflow conflicts are possible but rare; the dedup effect of `applied_jobs.json` means the worst outcome is applying to the same job twice (not catastrophic). Accept this risk for now; a proper solution (shared lock file, external state store) is deferred.

### 3.8 Workday account for the CBA tenant

CBA's Workday almost certainly requires account creation on first run. The existing `signInOrCreateAccount` in `lib/ats/workday.ts` handles this:
1. Attempts sign-in with `SEEK_EMAIL` + `WORKDAY_PASSWORD`
2. If sign-in fails, attempts account creation
3. If account creation triggers email verification, returns `verify_email` → logged as `needs_manual_review`

**First-run procedure:**
1. Set `WORKDAY_PASSWORD` secret to a strong password (if not already set)
2. Run `company-apply.ts --company cba --dry-run` locally with `headed=true` (set `interactive` env)
3. Bot will hit the account creation wall → `workday_account_verify_email` logged
4. Check `mohdrumman1@gmail.com`, click the verification link
5. Re-run — bot now signs in successfully and proceeds through the apply wizard
6. Push `WORKDAY_PASSWORD` to GitHub Secrets; all future CI runs use the same account

**Per-tenant account isolation:** Each Workday tenant maintains its own account database. A CBA Workday account does not work on Nine's Workday, etc. The single `WORKDAY_PASSWORD` is fine — the email is the same (`SEEK_EMAIL`) but the password registers separate accounts per tenant.

### 3.9 Suggested implementation sequence

1. Extract shared helpers to `lib/apply-utils.ts` (or accept duplication in MVP — note it)
2. `lib/crawlers/types.ts` + `lib/crawlers/cba.ts` — implement scraper, verify it returns sensible links locally
3. `scripts/company-apply.ts` — wire crawler into the apply pipeline
4. Add `"company": "ts-node scripts/company-apply.ts"` to `package.json`
5. Pre-populate CBA KB entries (§3.5)
6. Local dry-run: `npm run company -- --company cba --dry-run` in headed mode — confirm links are scraped, Workday account created/signed-in, forms filled but not submitted
7. Complete email verification (§3.8) if triggered
8. Live test run: `npm run company -- --company cba --max 3` — confirm 3 applications submitted and tracked
9. Create `.github/workflows/cba-apply.yml`
10. Commit and push; verify the workflow fires on schedule

### 3.10 Estimated effort

| Task | Hours |
|---|---|
| `lib/apply-utils.ts` extraction | 1 |
| CBA scraper + crawler interface | 2 |
| `company-apply.ts` script | 2 |
| KB priming | 0.5 |
| Workflow YAML | 0.5 |
| Local dry-run + email verification | 1 |
| Live test + fixes | 2 |
| **Total** | **~9 h** |

### 3.11 Test plan

1. `npm run company -- --company cba --dry-run` locally (headed): confirm scraper returns >0 links for target roles; confirm Workday forms are filled and NOT submitted; confirm no writes to `applied_jobs.json`
2. Check `tmp/cba-bot.log` for `ats: workday — applied` or `workday_account_verify_email` entries
3. If `verify_email`: complete verification, re-run dry-run — should now show full wizard fill
4. Live run `--max 3`: confirm 3 rows in `data/applications.csv` with `ats_provider=workday` and `external_url` containing `cba.wd3`
5. Second run with same 3 job IDs: confirm they are skipped as `already_applied`
6. Dispatch `cba-apply.yml` with `dry_run=true` from GitHub Actions UI — confirm log output, no CSV changes
