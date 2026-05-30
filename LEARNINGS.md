# Learnings & Known Fixes

Append new entries at the TOP, separated by `---`.

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
