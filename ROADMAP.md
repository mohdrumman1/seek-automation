# Seek Automation — Roadmap

## Status

**Phase 1: Core bot** — Complete ✅  
Pushed to `develop`, merged to `main`. Running 3×/day via GitHub Actions (6:17am, 12:17pm, 6:17pm AEST).

---

## What's Working

- SEEK session management (loads from `SEEK_SESSION_COOKIES` env / disk, saves slim session back to GitHub Secret after each run)
- 9 job searches across PM and SE roles, NSW + QLD, salary filter $120k+
- Resume variant selection (`pm` / `se`) by job title pattern matching
- Cover letter tailoring per job via OpenRouter (Gemini 2.0 Flash)
- Employer question answering via KB lookup + AI fallback
- Circuit breaker: bails a search after 3 consecutive failures, resets on success
- Run cap (`MAX_APPS_PER_RUN=20`) and per-search cap (`MAX_APPS_PER_SEARCH=10`)
- `DRY_RUN=true` mode: fills everything, never submits, never writes to applied_jobs.json
- Structured JSON logging to stdout/stderr
- Screenshots + AI analysis on validation errors and unexpected states
- Auto-skip (no hang) when running headless in CI (no TTY)
- Data committed back to repo after each run: `applied_jobs.json`, `questions_kb.json`, `review-queue.json`, `error-log.json`

---

## Known Gaps (actively improving)

| Gap | Notes |
|---|---|
| Yes/No radio buttons not clicked | SEEK renders Yes/No as `input[type="radio"]` — not yet handled |
| Employer questions with radio groups often block continue | Same root cause as above |
| Screenshots missing at some auto-skip points | Being added progressively |
| External apply jobs always skipped | Needs ATS detection engine (Phase 5) |

---

## Phase 2 — Tracking & Reporting

**Goal:** Know what the bot did at a glance without reading raw JSON.

- CSV files: `data/applications.csv`, `data/skipped_jobs.csv`, `data/failed_jobs.csv`, `data/runs.csv`
- Fields: job_id, platform, title, company, location, salary_text, work_type, applied_at, status, resume_variant_used, cover_letter_used, skip_reason, failure_reason, requires_manual_review, screenshot_path
- `npm run weekly-review` → `reports/weekly-review-YYYY-MM-DD.md` (AI-generated summary of the week's applications, top rejection patterns, suggested KB improvements)
- Migrate `applied_jobs.json` → CSV or keep as index + CSV for reporting

---

## Phase 3 — Platform Abstraction

**Goal:** Clean interface so adding a new platform doesn't require touching the SEEK-specific code.

- `lib/platforms/types.ts` — `JobPlatform` interface (search, apply, isExternal, detectATS)
- `lib/platforms/seek.ts` — extract current SEEK logic
- `scripts/apply.ts` — replaces `seek-apply.ts`, supports:
  - `--platform seek|indeed|glassdoor`
  - `--url "<job url>"` to apply to a single job directly
  - `--dry-run`, `--no-submit`, `--max <n>`

---

## Phase 4 — Resume Tailoring

**Goal:** Customise bullet points per job, not just the cover letter.

- OpenRouter analyses job description → selects most relevant experience bullets
- Outputs `tmp/current-tailored-resume.docx` (preserves formatting)
- Validation step: AI confirms no invented experience before applying
- Falls back to base resume if tailoring fails or confidence is low

---

## Phase 5 — External Apply (ATS Engine)

**Goal:** Handle jobs that redirect to external ATS (currently always skipped).

- Detect ATS provider: Workday, Greenhouse, Lever, SmartRecruiters, Ashby, iCIMS, PageUp
- Generic form fill for standard fields (name, email, phone, resume upload, cover letter)
- Safety check before submit: flag if any PII-sensitive fields appear
- Log `ats_provider_detected` and `external_apply_url` in tracking CSV

---

## Phase 6 — Indeed + Glassdoor

**Goal:** Broader job coverage beyond SEEK.

- Indeed Smart Apply (requires separate session management)
- Glassdoor: detect external ATS and log; direct apply where available
- Both use Phase 3 platform abstraction layer

---

## Phase 7 — Hardening

- Unit tests: KB lookup, fit scoring, CSV writing, weekly report generation, ATS detection
- Integration test: dry-run end-to-end against a known SEEK job URL
- PII redaction in logger (mask email, phone, TFN if they accidentally appear in logs)
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

## Secrets Setup (one-time)

| Secret | What |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key (Gemini 2.0 Flash) |
| `SEEK_EMAIL` | SEEK account email |
| `SEEK_SESSION_COOKIES` | Base64-encoded slim SEEK session (auto-rotated each run) |
| `GH_PAT` | Fine-grained PAT: `seek-automation` repo, Secrets read+write — needed for auto-rotation |
