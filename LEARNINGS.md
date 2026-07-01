# Learnings & Known Fixes

Append new entries at the TOP, separated by `---`.

---

## 2026-07-01 — 30-day audit: OpenRouter model deprecation, resume-selector placeholder bug, second page.goto crash site, ATS selector drift

**Tags:** openrouter, gemini, model-deprecation, resume-selector, placeholder, playwright, page.goto, nav-timeout, ats, pageup, jobadder, cornerstone, teamtailor, workday, submit-selector, audit
**Status:** Fixed

**Issue:** 30-day GitHub Actions audit surfaced 6 clusters degrading apply rate:
1. Every OpenRouter call 404'd on `google/gemini-2.0-flash-001` → all resume tailoring + all vision analyzer calls failed, cascading to base cover-letter + no error analysis.
2. `lib/resume-selector.ts` fell back to `bestIdx = 0` when no keyword matched — index 0 is SEEK's disabled `"Please select a resumé"` placeholder. `selectOption({ index: 0 })` timed out at 30s and every job in the run failed `unexpected_error`.
3. PageUp `ats_pageup_no_submit` persisting at 10–13/run (submit-button selectors too narrow across tenants).
4. JobAdder/Cornerstone/Teamtailor/Workday intermittent submit failures from similar selector drift.
5. Regression of the 2026-05-31 SERP-nav fix — the *second* `page.goto` in `scripts/apply.ts` (per-job detail nav, ~line 178) was still unwrapped and could crash the whole main loop (run 27105508574).
6. No alarm signal when Workday falls back to creating a new account, which is the marker for a password rotation the user must handle manually.

**Investigation:** `grep -n google/gemini` narrowed to a single ref in `lib/openrouter.ts:7`. Read `lib/resume-selector.ts` lines 80–122 and traced fallback to `bestIdx = 0` when `bestScore === 0`. `rg -n 'page\.goto\(' scripts/ lib/` mapped all nav call sites; only the SERP one (~150) was wrapped by commit `3a006a3`. Read each ATS handler to confirm submit-button selectors + failure-path `captureAndAnalyze` presence.

**Root cause:**
1. `lib/openrouter.ts:7` hard-coded a single deprecated model id; `withRetry` correctly treats 404 as non-retryable but the log line didn't call out deprecation.
2. `lib/resume-selector.ts:90` initialised `bestIdx = firstRealIdx >= 0 ? firstRealIdx : 0` but the loop *then* iterated over *all* options including index-0 placeholder; when nothing scored > 0 the initial value stuck at 0. Also `PLACEHOLDER_RE` did not match `"Please select a resumé"` because of the trailing accented character.
3. Per-tenant CSS drift on ATS submit buttons — narrow `has-text("Submit")` selector lists miss "Submit application" variants, `data-test-id` / `data-cy` attrs, `input[type=submit]`, and role-button patterns.
4. `scripts/apply.ts:178` used raw `page.goto(url)` (Playwright default: 30s, `waitUntil: 'load'`), no try/catch — the same crash pattern as the 2026-05-31 fix.
5. Workday `signInOrCreateAccount` logged account creation as `info` — invisible next to normal apply chatter.

**Fix:**
- `lib/openrouter.ts:7-11` — swap default to `google/gemini-2.5-flash`; add `OPENROUTER_MODEL` + `OPENROUTER_VISION_MODEL` env overrides; separate `MODEL` (text) and `VISION_MODEL` (vision) so the vision call uses the right constant at line 65. `lib/openrouter.ts:24-32` — when status === 404 log an explicit `error`-level line: `"OpenRouter model may be deprecated — set OPENROUTER_MODEL env to override"` with the model id. Retry semantics unchanged.
- `lib/resume-selector.ts:87-115` — broaden `PLACEHOLDER_RE` to match `"please\s+select"` and `"select a resum"` (partial match, no `$` anchor). Skip placeholder-labeled options *inside* the scoring loop. Add hard invariant right before `selectOption`: if the resolved index still points to a placeholder-labeled option, throw `resume_no_valid_option`. Add `logger.debug` right before the click capturing `chosenIndex`, `chosenLabel`, `totalOptions`.
- `lib/platforms/seek.ts:910-919` — wrap `selectResume` in try/catch; on `resume_no_valid_option` return `{ success: false, failureReason: 'resume_no_valid_option' }` instead of letting the throw become a generic `unexpected_error`.
- `scripts/apply.ts:178-195` — wrap per-job `page.goto` in try/catch with `{ timeout: 60_000, waitUntil: 'domcontentloaded' }`; on failure log `job nav failed — skipping job`, record `failureReason: 'nav_timeout'`, `continue`. Same treatment applied to Indeed search nav (~line 305) and Indeed per-job nav (~line 335).
- `lib/apply-utils.ts:75-81` — wrap the single-URL entry `page.goto` (same treatment).
- `lib/platforms/indeed.ts:237-243` — wrap the external-ATS nav (slowest, most timeout-prone). Log + return `nav_timeout` failure instead of crashing.
- `lib/ats/pageup.ts:108-125` — broaden submit-button selector: adds `"Submit application"`, `button[type="submit"]`, `input[type="submit"]`, `[data-test-id*="submit"]`, `[data-testid*="submit"]`, `[data-cy*="submit"]`, `.submit-btn`, `.js-submit-application`, `[role="button"]:has-text("Submit")`. `tickConsentCheckboxes` (lines 128–148) — broaden regex to include `i confirm | declar(e|ation) | read and understood | conditions of use`, click the associated `label[for]` first (many PageUp checkboxes are visually covered), skip disabled boxes.
- `lib/ats/jobadder.ts:76-88` — broaden submit selector to same superset + `input[type=submit]`, `input[value*="Submit"]`, `[data-test-id/testid/cy*="submit"]`, `[role=button]:has-text("Submit")`. Added `scrollIntoViewIfNeeded` before click.
- `lib/ats/cornerstone.ts:106-116` — pass extra selectors to `clickSubmit` including `Apply now`, `[data-test-id*=submit]`, `#btnSubmitApplication`, `.js-submit-application`.
- `lib/ats/teamtailor.ts:104-112` — broaden submit selector with same superset.
- `lib/ats/workday.ts:141-152` — broaden the primary nav selector: adds `[data-automation-id="wd-CommandButton_uic_okButton"]`, `[data-automation-id*="submit"]`, `Continue`, `Submit application`, `Review and Submit`, `Apply now`, `input[type="submit"]`, `[data-test-id/testid/cy*="submit"]`, `[role=button]:has-text("Submit")`.
- `lib/ats/workday.ts:349-361` (post `logger.info('new account created successfully')`) — emit a distinct `warn`-level alarm: `WORKDAY_ACCOUNT_CREATED_FALLBACK` with tenant hostname + URL + job ctx so it can be grep'd out of runs. User rotates `WORKDAY_PASSWORD` (and shifts old to `WORKDAY_PASSWORD_FALLBACK`) when this fires.

**Verify:**
- `npx tsc --noEmit` clean (zero errors).
- `rg -n 'gemini-2\.0-flash-001|gemini-2-0-flash-001'` → 0 hits.
- `rg -n 'page\.goto\(' scripts/ lib/` — every hit inside main loops now wrapped; remaining unwrapped calls are login/bootstrap navs, one-shot utility scripts, or already inside a try/catch.
- `rg -n 'Please select|select a resum' lib/resume-selector.ts` shows the broadened `PLACEHOLDER_RE`.
- `rg -n WORKDAY_ACCOUNT_CREATED_FALLBACK lib/` shows the alarm at `lib/ats/workday.ts` post-account-creation.

**If it recurs:**
- OpenRouter 404 again → export `OPENROUTER_MODEL=<new-id>` in the workflow env (`.github/workflows/seek-apply.yml` etc.); check `https://openrouter.ai/models` for current recommended model.
- Resume-selector still selecting a bad option → check the debug log line `about to selectOption on resume dropdown` for the actual `chosenLabel`; extend `PLACEHOLDER_RE` if SEEK introduces a new placeholder wording.
- New ATS-submit failure cluster → inspect the diagnostic screenshot at `screenshots/errors/*_ats_<vendor>_no_submit.png`; grep the failing HTML for the submit button attrs and add them to the vendor's selector list.
- `WORKDAY_ACCOUNT_CREATED_FALLBACK` appears in logs → rotate secrets per the 2026-05-31 entry's playbook.

---

## 2026-06-02 — Indeed bot fully disabled

**Tags:** indeed, ci, github-actions, workflow, cloudflare, proxy, disabled
**Status:** Workaround

**Issue:** Per the 2026-05-29 LEARNINGS entry "Indeed zero-jobs on CI", Cloudflare IP-blocks GitHub Actions runners, so Indeed runs return zero jobs. Commit `32c0e00` already disabled the cron, but `workflow_dispatch` remained — meaning the workflow could still be triggered manually and waste a run (~3 min checkout/install/Playwright bootstrap before discovering zero jobs).

**Investigation:** Read `.github/workflows/indeed-apply.yml`. Confirmed cron block was already commented (commit `32c0e00`). Confirmed the only other trigger was `workflow_dispatch:` with a `dry_run` boolean input. Confirmed no `push:`, `pull_request:`, `schedule:` (uncommented), `workflow_run:`, or `workflow_call:` triggers existed. The job-level `if: github.ref == 'refs/heads/main'` was the only execution guard — too weak; `workflow_dispatch` runs on main by default.

**Root cause:** No upstream fix yet (residential proxy not wired). Indeed continues to be unusable from GitHub-hosted runners while the IP block persists.

**Fix:** In `.github/workflows/indeed-apply.yml` — (1) added a top-of-file header comment noting the disable date and reason. (2) Commented out the entire `workflow_dispatch:` block (with its `dry_run` input). GitHub Actions requires an `on:` trigger, so kept a bare `workflow_dispatch:` placeholder on a single line with an inline comment explaining the role. (3) Added belt-and-suspenders job-level guard: `if: false` on the `apply` job (with the original `if: github.ref == 'refs/heads/main'` preserved as a commented line for easy restoration). Net effect: the workflow can be triggered manually but the job is skipped immediately — no checkout, no Playwright install, no runner minutes burned. File kept for future re-enablement when residential proxy lands.

**Verify:**
- `git diff .github/workflows/indeed-apply.yml` — confirm header comment added, `workflow_dispatch` block fully commented (placeholder retained), `if: false` on apply job.
- `grep -nE '^on:|^\s+(push|pull_request|schedule|workflow_run|workflow_call):' .github/workflows/indeed-apply.yml` — should only show `on:` (line 4). No other active triggers.
- Manual sanity in GitHub UI: clicking "Run workflow" on the Indeed Auto Apply page will start a run that completes in <10s with a single skipped job.

**If it recurs:** If you see Indeed runs appearing in the Actions tab, check (a) the `if: false` guard is still on the `apply` job, and (b) no new trigger (`push`, `schedule`, etc.) was added. To re-enable when the residential proxy is wired: remove the `if: false` line, uncomment `if: github.ref == 'refs/heads/main'`, uncomment the full `workflow_dispatch:` block, uncomment the `schedule:` block, delete the placeholder `workflow_dispatch:` line, and update this LEARNINGS entry's Status to `Fixed` with the proxy commit reference.

---

## 2026-05-31 — Workday password rotation handled via fallback env var

**Tags:** workday, ats, auth, password-rotation, cba, secrets
**Status:** Fixed

**Issue:** Rotating `WORKDAY_PASSWORD` in GitHub Actions secrets (or anywhere) breaks any environment that still has the old value cached — most commonly local `.env` vs CI, or one CI workflow vs another if they were updated at different times. The CBA direct-Workday flow + Phase 5 SEEK→Workday handler both authenticate against Workday with `WORKDAY_PASSWORD`; either failing to sign in surfaces as `'ats: workday — sign in failed, trying create account'` followed by a wasted create-account attempt (or `ats_requires_account` if create-account also fails).

**Investigation:** Grepped `WORKDAY_PASSWORD` across `*.ts`/`*.js`/`*.yml`. The only login submit site is `lib/ats/workday.ts:signInOrCreateAccount` — `scripts/company-apply.ts` (CBA) and `scripts/seek-apply.ts` both route through `applyToSingleUrl` → `applyWorkday` → `signInOrCreateAccount`. Three workflows (`cba-apply.yml`, `seek-apply.yml`, `indeed-apply.yml`) pass `WORKDAY_PASSWORD` explicitly.

**Root cause:** Single-source password with no rotation grace period — any rotation event is a hard cutover with zero tolerance for stragglers (`lib/ats/workday.ts:183` previously read only `WORKDAY_PASSWORD`).

**Fix:** Added `WORKDAY_PASSWORD_FALLBACK` env var support. New helper `attemptSignInWithPassword(page, password)` in `lib/ats/workday.ts` returns `'ok' | 'auth_failed' | 'other'`. `signInOrCreateAccount` calls it with the primary password first; on `'auth_failed'` AND when `WORKDAY_PASSWORD_FALLBACK` is set AND different from primary, it retries once with the fallback. Logs `'(primary password)'` vs `'(fallback password)'` on success. Single-attempt behavior preserved when fallback unset. Workflows `cba-apply.yml`, `seek-apply.yml`, `indeed-apply.yml` updated to pipe `WORKDAY_PASSWORD_FALLBACK` from secrets to env and to `.env` write step. Local `.env` and GH secret `WORKDAY_PASSWORD_FALLBACK` populated with previous value. Commit `ef7534d`.

**Verify:**
- `npx tsc --noEmit` clean
- `gh secret list -R mohdrumman1/seek-automation | grep WORKDAY` shows both `WORKDAY_PASSWORD` and `WORKDAY_PASSWORD_FALLBACK`
- Next CBA scheduled run should log either `signed in to existing account (primary password)` or `(fallback password)`

**If it recurs:** When rotating Workday password again:
1. Set new value as `WORKDAY_PASSWORD` (secret + local `.env`).
2. Set previous value as `WORKDAY_PASSWORD_FALLBACK` (secret + local `.env`).
3. Once a successful run logs `(primary password)`, the fallback can be safely cleared on next rotation (it's only a safety net).
If sign-in still fails: check for new Workday error-banner selectors — current detection uses `[data-automation-id="signInGlobalErrorMessage"]` plus `[role="alert"]` text "incorrect"/"invalid"; Workday tenants sometimes vary copy ("Invalid email address or password.").

---

## 2026-05-31 — SEEK main loop crashes on slow SERP nav

**Tags:** seek, playwright, page.goto, timeout, main-loop, ci
**Status:** Fixed

**Issue:** Single `page.goto` failure on a SEEK search results URL crashes the entire bot and aborts all remaining searches. Quoted error from run 26705511029:
```
"main loop crashed","error":{"name":"TimeoutError","message":"page.goto: Timeout 30000ms exceeded.
- navigating to \"https://www.seek.com.au/full-stack-developer-jobs/in-New-South-Wales?...\",
waiting until \"load\"\n    at main (/home/runner/work/seek-automation/seek-automation/scripts/apply.ts:150:18)"
```
48 skipped + 9 failed had already been processed; all remaining searches were abandoned and the workflow exited 1.

**Investigation:** `gh run view 26705511029 --log-failed`. Stack trace pointed at `scripts/apply.ts:150`. Inspection of that file showed `page.goto(search.url)` with no try/catch and no timeout override — Playwright's default 30s `load` wait timeout fired on a slow SEEK response.

**Root cause:** Unhandled nav in the per-search loop in `scripts/apply.ts`. Default Playwright `goto` waits up to 30s for the `load` event, which is fragile against transient SEEK slowness on GitHub Actions runners.

**Fix:** Wrap the `page.goto` in try/catch in `scripts/apply.ts`; on failure log a warn and `continue` to the next search. Bumped timeout to 60s and switched to `waitUntil: 'domcontentloaded'`.

**Verify:** Trigger a fresh run via `gh workflow run seek-apply.yml`; confirm the run completes without `main loop crashed` in the logs even if some searches log `search nav failed — skipping search`.

**If it recurs:** Check whether multiple searches in a row are failing — that points at SEEK rate-limiting or an IP block. Inspect `lib/scrapers/seek.ts` for any selector changes that would make `domcontentloaded` insufficient.

---

## 2026-05-29 — Indeed cron disabled: Cloudflare IP block on Actions runners

**Tags:** indeed, cloudflare, ip-block, cron-disabled, github-actions
**Status:** Workaround

**Issue:** Indeed bot silently produced zero applications on every scheduled CI run. Diagnostic capture (run 26611282451) revealed the SERP was never reached — Cloudflare served an "Additional Verification Required" interstitial (Ray ID `a0318538dbc2c93c`) with a 250-byte body before any job results rendered.

**Investigation:** Followed up on prior LEARNINGS entry "Indeed bot silent-failing". Diagnostic JSON payload from the workflow showed `title: "Just a moment..."`, `h1: "Additional Verification Required"`, body length 250 bytes. Confirms Cloudflare edge block on the GitHub Actions datacenter IP range — not selector drift, not cookie expiry, not a no-results page.

**Root cause:** GitHub Actions runners live in datacenter IP ranges that Cloudflare aggressively challenges. No amount of cookie freshness or selector tuning bypasses this — the block happens at the edge, before any Indeed code runs.

**Fix:** Disabled the `schedule:` block in `.github/workflows/indeed-apply.yml` (commented out, not deleted). `workflow_dispatch:` retained for manual debugging from a local/proxied context. No application code changed.

**Verify:** `gh workflow view indeed-apply.yml` should show no scheduled runs. `gh workflow run indeed-apply.yml` should still trigger a manual run.

**If it recurs (or to re-enable):** Re-enable only after one of: (a) residential proxy wired via `INDEED_PROXY_URL` secret + Playwright proxy config, (b) self-hosted runner on a non-datacenter IP, or (c) Indeed API integration replacing scraping. Uncomment the `schedule:` block and remove the disable comment line.

---

## 2026-05-29 — Indeed bot silent-failing: 0 jobs collected on every search on CI

**Tags:** indeed, bot-detection, ip-block, getJobLinks, silent-failure, observability, cookies
**Status:** Diagnosed + observability fix applied; root-cause confirmation requires next CI run artifact

**Issue:** Every Indeed run reports green in GitHub Actions but produces zero applications. `data/applications.csv` has zero Indeed rows ever recorded. The most recent run (workflow id 26605343682, 2026-05-28T22:13) logs:

```
"indeed loop starting","data":{"remainingBudget":100}
"indeed search starting","data":{"name":"PM Sydney (Indeed)"}
"indeed: job links collected","data":{"count":0}
"indeed search jobs found","data":{"name":"PM Sydney (Indeed)","count":0}
```

…repeated for all 5 Indeed searches, then `"apply bot done","applied":0`. Same pattern on every prior Indeed run going back to commit 8876b4b ("fix Indeed zero-apply rate") — Indeed has in fact never produced an application since the platform was added.

**Investigation:**
1. Confirmed workflow runs all green (last 8 runs `conclusion: success`).
2. Confirmed `data/applications.csv` Indeed count = 0; `data/skipped_jobs.csv` Indeed count = 0; `data/sr-queue.json` Indeed count = 0. The bot is finding zero jobs to even attempt — not failing at apply, failing at discovery.
3. Reproduced the exact `IndeedPlatform.getJobLinks` flow locally (same UA, viewport, `networkidle` wait, scroll loop). Result: **16 `[data-jk]` cards collected**. URL: `https://au.indeed.com/jobs?q=project+manager&l=Sydney+NSW&salaryType=yearly&salary=%24120%2C000%2B&fromage=7&sort=date`, title: "50 Project Manager Jobs and Work in Sydney NSW | Indeed", no captcha, no Cloudflare challenge, no "no results" message.
4. Local probe was a fresh context with NO cookies. CI loads `INDEED_SESSION_COOKIES` (21 cookies) before navigating.
5. Therefore the empty SERP on CI is environment-specific — either (a) Indeed bot-detection serving an empty/blocked SERP to GitHub Actions datacenter IPs, or (b) the stored cookies are corrupted/expired and triggering a soft redirect that the script doesn't notice.

**Root cause:** CI-side: Indeed's search results page returns an empty/blocked SERP when fetched from the GitHub Actions runner with the current session cookies. `lib/platforms/indeed.ts:65-75` (the `getJobLinks` selector query) is selecting against a page that has no `[data-jk]` elements — most likely a bot-challenge interstitial or empty SERP variant. We currently have no logged screenshot of what CI actually sees, so the exact mechanism is not yet confirmed.

**Fix:**
- `lib/platforms/indeed.ts:58-105`: added diagnostic capture when `getJobLinks` returns 0 — logs page title, URL, body length, h1, captcha/no-results detection, and snippet; writes a screenshot to `screenshots/indeed-debug/zero-links-<ts>.png`. Purely additive — only runs on the failure path.
- `.github/workflows/indeed-apply.yml`: changed artifact upload from `if: failure()` to `if: always()` and added `screenshots/indeed-debug/` to the path so the next zero-link run produces a downloadable artifact showing exactly what Indeed served.

**Verify:**
1. Wait for the next scheduled Indeed run (cron: `17 20|02|08 * * *`) or trigger via workflow_dispatch.
2. Download the `indeed-bot-logs` artifact and inspect `screenshots/indeed-debug/zero-links-*.png`.
3. The screenshot + the new `"indeed: zero links collected — page diagnostic"` log line will reveal which of: (a) Cloudflare/captcha wall → IP block, fix with rotating proxy or self-hosted runner, (b) empty SERP → cookie-driven personalization, fix by refreshing `INDEED_SESSION_COOKIES` secret, (c) login redirect → session expired, refresh secret, (d) genuinely empty results → query parameter issue.

**If it recurs:**
- First grab the latest `indeed-bot-logs` artifact and look at the screenshot.
- If captcha/CF: this is unfixable from inside the runner — switch to a residential-IP service (Bright Data, ScrapingBee) or self-hosted runner on a residential network.
- If sign-in/redirect: log in to indeed.com.au locally, export cookies via the same flow used for SEEK (`scripts/seek-login.ts` pattern, needs an Indeed equivalent), base64 the storageState JSON, update GitHub secret `INDEED_SESSION_COOKIES`.
- If empty SERP despite valid session: Indeed may have deprecated old query params; try `https://au.indeed.com/jobs?q=project+manager&l=Sydney+NSW` minimal URL and add filters back one at a time.
