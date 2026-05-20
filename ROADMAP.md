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

## Phase 6 — Indeed + Glassdoor

**Goal:** Broader job coverage beyond SEEK.

- Indeed Smart Apply (requires separate session management)
- Glassdoor: detect external ATS and log; direct apply where available
- Both use Phase 3 platform abstraction layer

---

## Phase 7 — On-Demand Single-Job Apply

**Goal:** Trigger the bot to apply to one specific job by pasting a URL — no search loop.

Single-URL mode already exists locally via `ts-node scripts/apply.ts --url <job-url>` and `npm run seek -- --url <job-url>`. What's needed is a convenient remote trigger:

- Add a `workflow_dispatch` input field `job_url` to the GitHub Actions workflow — paste a SEEK URL into the GitHub UI and click Run
- The bot applies to that single job and exits; full logs available in the Actions run
- Could also accept an `au.seek.com` or `seek.com.au` job URL and normalise the domain automatically
- Longer term: a lightweight webhook or Slack slash command so it can be triggered from mobile

---

## Phase 8 — Hardening

- Unit tests: KB lookup, fit scoring, CSV writing, weekly report, ATS detection
- Integration test: dry-run end-to-end against a known SEEK job URL
- PII redaction in logger (mask email, phone, TFN if accidentally in logs)
- Retry + backoff in OpenRouter calls (429/5xx)
- `error-log.json` rotation (cap at 500 entries)
- Replace `waitForTimeout` with `waitForLoadState` where possible

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
