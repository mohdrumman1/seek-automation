# Seek Automation — Roadmap

## Status

**Phase 1–3: Core bot, tracking, platform abstraction** — Complete ✅  
Running 3×/day via GitHub Actions (6:17am, 12:17pm, 6:17pm AEST).  
268 applications submitted as of 2026-05-18.

---

## What's Working

- SEEK session management (loads from `SEEK_SESSION_COOKIES` env / disk, saves slim session back after each run)
- Session validity check via URL-redirect on `/my-activity` — immune to SEEK DOM changes
- 9 job searches across PM and SE roles, NSW + QLD, salary filter $120k+
- Resume variant selection (`pm` / `se`) by job title pattern matching
- Cover letter tailoring per job via OpenRouter (Gemini 2.0 Flash)
- Employer question answering: KB lookup → AI fallback, with auto-save to KB
- Radio button and checkbox group handling (grouped by `name` attribute, label-first click)
- Dropdown selection with correct numeric proximity matching (comma-aware) and `\xa0` normalisation
- Circuit breaker: bails a search after 3 consecutive failures, resets on success
- Run cap (`MAX_APPS_PER_RUN=20`) and per-search cap (`MAX_APPS_PER_SEARCH=10`)
- `DRY_RUN=true` mode: fills everything, never submits, never writes state
- Structured JSON logging, screenshots + AI error analysis on failures
- CSV tracking: `applications.csv`, `skipped_jobs.csv`, `failed_jobs.csv`, `runs.csv`
- `npm run weekly-review` — AI-generated markdown summary of the week's applications
- Auto-skip (no hang) when running headless in CI

---

## Known Gaps

| Gap | Notes |
|---|---|
| External apply jobs always skipped | 78% of skips — needs ATS engine (Phase 5) |
| Resume not tailored per job | Env var `RESUME_TAILORING_ENABLED` is set — implementation is Phase 4 |
| OpenRouter calls have no retry/backoff | 429/5xx failures are silent — Phase 7 |
| `error-log.json` grows unbounded | Needs rotation at ~500 entries — Phase 7 |
| Date pickers / file upload fields | Not handled — those jobs will always fail |

---

## Phase 4 — Resume Tailoring ✅

**Goal:** Send a per-job tailored resume, not just a tailored cover letter.

- OpenRouter analyses job description → selects most relevant experience bullets from base resume
- Outputs `tmp/current-tailored-resume.docx` (preserves formatting via `docx` or `python-docx`)
- Validation step: AI confirms no invented experience before applying
- Falls back to base resume variant (`pm` / `se`) if tailoring fails or confidence is low
- Hooks into `RESUME_TAILORING_ENABLED` env var already wired in the workflow

---

## Phase 5 — External Apply (ATS Engine)

**Goal:** Handle jobs that redirect to external ATS (currently 78% of skips).

Priority ATS platforms for Australian PM/SE roles:
- **PageUp** — government, infrastructure, large enterprise (most common in AU)
- **Workday** — large corporates
- **Greenhouse** — tech companies

For each:
- Detect ATS provider from URL or page fingerprint
- Generic form fill: name, email, phone, resume upload, cover letter
- Safety check before submit: flag if any PII-sensitive fields appear (TFN, DOB, bank details)
- Log `ats_provider_detected` and `external_apply_url` in tracking CSV

---

## Phase 6 — Indeed (Glassdoor deferred indefinitely)

**Goal:** Broader job coverage via Indeed Australia.

- Indeed external-apply jobs: detect ATS on redirect URL → Phase 5 ATS engine handles it
- Indeed Easy Apply: deferred to Phase 6.5 (cross-origin iframe, needs its own phase)
- Session loaded from `INDEED_SESSION_COOKIES` secret (base64 cookie JSON, manual export — no scripted login)
- 5 search queries: Project Manager (Sydney/Brisbane), Delivery Manager (Sydney), Software Engineer (Sydney), AI Engineer (remote AU), all $120k+
- Runs sequentially after SEEK in the same Actions job, behind `INDEED_ENABLED=true` flag
- Uses Phase 3 platform abstraction (`JobPlatform` interface)

**Why not Glassdoor:**
Glassdoor sits behind Cloudflare Turnstile which defeats Playwright headless reliably — there is no clean workaround without a paid proxy/undetected-browser service. Additionally, ~90% of Glassdoor listings are syndicated Indeed jobs or redirect to external ATS platforms already handled by Phase 5. The marginal listing coverage does not justify the maintenance cost of a permanently-broken scraper.

---

## Phase 7 — On-Demand Single-Job Apply

**Goal:** Trigger the bot to apply to one specific job by pasting a URL — no search loop.

Single-URL mode already exists locally via `ts-node scripts/apply.ts --url <job-url>` and `npm run seek -- --url <job-url>`. What's needed is a convenient remote trigger:

- Add a `workflow_dispatch` input field `job_url` to the GitHub Actions workflow — paste a SEEK URL into the GitHub UI and click Run
- The bot applies to that single job and exits; full logs available in the Actions run
- Could also accept an `au.seek.com` or `seek.com.au` job URL and normalise the domain automatically
- Longer term: a lightweight webhook or Slack slash command so it can be triggered from mobile

---

## Phase 8 — Hardening ✅

- Unit tests: KB lookup, CSV writing, ATS detection, select-best-option (28 passing) ✅
- Integration test: dry-run end-to-end against a known SEEK job URL (skips if no cookies) ✅
- PII redaction in logger (mask email, phone, TFN if accidentally in logs) ✅
- Retry + backoff in OpenRouter calls (429/5xx — 3 retries, exponential backoff + jitter) ✅
- `error-log.json` rotation (cap at 500 entries, oldest-first trim) ✅
- Replace nav-follow `waitForTimeout` with `waitForLoadState` (seek.ts + apply.ts) ✅

---

## Phase 10 — CommBank Direct (Workday Careers Portal) ✅

**Goal:** Apply directly to Commonwealth Bank roles sourced from `cba.wd3.myworkdayjobs.com`, without relying on CBA syndicating those listings to SEEK.

**Background:** CBA is one of Australia's largest employers of PM and tech roles. CBA jobs that redirect from SEEK already work through the Phase 5 Workday handler (`.wd3.` pattern detected, `applyWorkday` called). What's missing is direct sourcing — capturing CBA-only roles not listed on SEEK.

**What needs to be built:**

1. **CBA careers scraper** (`lib/crawlers/cba.ts`) — navigates `cba.wd3.myworkdayjobs.com/en-US/CBA_Careers`, filters to target roles (PM, delivery, SE, AI, cloud) and NSW/QLD/remote, returns job application URLs; deduplicates against `applied_jobs.json`

2. **`CompanyCrawler` interface** (`lib/crawlers/types.ts`) — `getJobLinks(page): Promise<string[]>` — same shape as `JobPlatform.getJobLinks` but for a direct company careers portal; keeps the crawler separate from the SEEK/Indeed platform abstraction

3. **CBA-specific KB priming** — pre-populate `data/questions_kb.json` with standard CBA screening answers (right to work → yes; currently employed by CBA → no; criminal history → manual review flag if required)

4. **Workday account handling** — each Workday tenant maintains its own account registry; `WORKDAY_PASSWORD` already exists and `signInOrCreateAccount` in workday.ts already attempts sign-in/creation. First run on a new tenant triggers email verification (one-time manual step); subsequent runs auto sign-in. Document verified tenants in `.env.example` (`WORKDAY_VERIFIED_TENANTS=cba`).

5. **`scripts/company-apply.ts`** — new entry point that loads a company crawler by name (`--company cba`), runs `getJobLinks`, feeds each URL to the existing `applyToSingleUrl` pipeline. Shares the same KB, cover-letter tailoring, resume tailoring, and tracker as the SEEK loop.

6. **New GitHub Actions workflow** (`.github/workflows/cba-apply.yml`) — runs on the same 3×/day schedule, behind a `COMPANY_CRAWLERS_ENABLED` secret flag; isolated from `seek-apply.yml` so a CBA failure doesn't block the SEEK run.

**Key constraints:**
- First Workday account creation requires one manual email-verification click — bot logs `workday_account_verify_email` and exits cleanly; user verifies, then next run proceeds automatically
- CBA's Workday may enforce MFA for some sessions — detect and return `needs_manual_review` same as the existing path
- Criminal history / financial-services compliance questions must trigger manual review if marked required — `hasSensitiveRequiredField` in `lib/ats/common.ts` already covers this
- Keep the same 6 s inter-application delay; CBA's Workday does not publish rate limits but same conservative pacing applies

**Estimated effort:** 8–10 hours (scraper + integration 4–6 h, KB priming 30 min, workflow 1 h, dry-run + live test 2 h)

---

## Phase 9 — Universal Job Link Apply

**Goal:** Accept any job URL from any site — not just SEEK — and apply to it autonomously.

Current limitation: the bot only accepts SEEK URLs (`seek.com.au/job/XXXXX`). If you paste a direct company careers page or external ATS URL, the bot can't scrape job details and the SEEK-specific "Apply" button flow doesn't exist.

**What needs to be built:**

1. **Universal job scraper** — given any URL (LinkedIn, Seek, Indeed, company careers page, Workday listing, etc.), extract: job title, company name, full job description, location, work type, salary. Use LLM vision/HTML extraction as fallback when structured selectors aren't available.

2. **Decouple job details from SEEK** — `applyToSingleUrl` currently calls `platform.getJobDetails(page)` which is SEEK-specific. This needs a platform-agnostic `extractJobDetails(page, url)` that picks the right extractor by URL pattern (SEEK, LinkedIn, raw Workday listing, generic HTML).

3. **Direct ATS entry** — if the URL is already an ATS application page (Workday, JobAdder, Teamtailor, etc.), skip the job listing page entirely and jump straight to the ATS handler with the scraped/provided job details.

4. **Resume + cover letter generation** — same tailoring pipeline as existing (already works), but now seeded from the universally-scraped job details.

5. **`normalise-url.js` upgrade** — extend to pass non-SEEK URLs through to the new universal path rather than normalising to `seek.com.au`.

6. **Workflow input** — no change needed; `job_url` input in `workflow_dispatch` already accepts any string.

**Priority extractors to support first:** SEEK (done), direct Workday listing page (`company.myworkdayjobs.com/jobs/...`), LinkedIn job posting, raw company careers page (generic HTML + LLM).

---

## Future Improvements

- **Raise `MAX_APPS_PER_RUN`** — currently capped at 100 total across SEEK + Indeed. With Indeed now running sequentially after SEEK, SEEK typically exhausts the budget before Indeed gets a turn. Once the first Indeed run is validated as working correctly, raise this to 150–200 and consider a per-platform budget split (e.g. `SEEK_MAX=100`, `INDEED_MAX=50`) so Indeed always gets a guaranteed share regardless of SEEK's output.

- **Indeed Easy Apply (Phase 6.5)** — the cross-origin iframe flow is currently skipped. Needs its own implementation phase.

- **Indeed session auto-rotation** — unlike SEEK, Indeed cookies aren't automatically rotated after each run. Add the same b64-write + secret-update pattern used for SEEK.

---

## Safety Guardrails (never to be removed)

- Never auto-submit if any of these appear: TFN, passport number, driver licence, date of birth, full home address, bank details, identity documents, references' contact details — log as `needs_manual_review_sensitive_info`
- Never invent experience, employers, dates, qualifications, certifications, salary history, or achievements
- Never bypass CAPTCHA, MFA, bot detection, or access controls
- If confidence is low on any answer, log for review instead of submitting
- Respect reasonable rate limits — no spammy behaviour

---

## Candidate Preferences

- Salary: $120,000 minimum
- Location: Newcastle, Sydney, Brisbane (NSW and QLD) — hybrid/remote preferred, no interstate relocation
- Roles: Project Manager (ICT), Technical Project Manager, Delivery Manager/Lead, Software Engineer (ICT), Full Stack Developer, Backend Developer, Cloud Engineer, AI Engineer, AI Consultant

---

## Secrets Setup

| Secret | What |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key (Gemini 2.0 Flash) |
| `SEEK_EMAIL` | SEEK account email |
| `SEEK_SESSION_COOKIES` | Base64-encoded slim SEEK session (auto-rotated each run) |
| `GH_PAT` | Fine-grained PAT: `seek-automation` repo, Secrets read+write — needed for auto-rotation |
