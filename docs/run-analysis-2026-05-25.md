# Run Analysis — 2026-05-25

## Stats
| Metric | Value |
|--------|-------|
| Applied | 2 |
| Skipped | 154 |
| Failed | 26 |
| Duration | 113 min |
| Apply rate | ~1% |

---

## Root Cause Summary

### Why 154 were skipped

| Reason | Count | Fixable? |
|--------|-------|----------|
| `location_out_of_region` | 93 | No — correctly filtered (VIC/SA/ACT/WA hybrid jobs) |
| `apply_button_not_found` | 31 | **Yes** — mostly "You applied on X" (SEEK hides Apply btn); some expired jobs |
| `ats_unknown_provider` | 14 | Partial — Suncorp, Allianz, Citi, Glencore; need URL patterns |
| `ats_queued_sr` | 13 | Expected — SmartRecruiters queue, handled separately |
| `security_clearance_required` | 3 | No — correct |

**Critical dedup bug**: the same job appears 4–5× in the same run (e.g. job `92272959` appeared 5×). The `seenThisRun` Set in `apply.ts` should prevent this but is not working. Likely cause: same job URL returned by multiple SEEK search queries, and a subtle bug in the dedup path. Fixed by promoting `logger.debug` → `logger.info` for dedup hits (to verify in CI logs) and adding `blocked_jobs.json` to permanently exclude unsolvable jobs.

### Why 26 failed

| Reason | Count | Root cause | Fix |
|--------|-------|-----------|-----|
| `validation_still_blocked` | 7 | SEEK profile missing required field on review page; same 2 jobs retried 3–4× each | `seek_profile_incomplete` skip → `blocked_jobs.json` |
| `ats_workday_no_submit` | 7 | "Start Your Application" modal not dismissed | `dismissStartYourApplicationModal()` in workday.ts |
| `ats_pageup_no_progress` | 6 | "By continuing" consent checkbox not ticked | `tickConsentCheckboxes()` in pageup.ts |
| `ats_pageup_no_submit` | 3 | Same consent issue; submit path also affected | Same fix |
| `ats_teamtailor_no_submit` | 1 | Submit button disabled until consent ticked; `isVisible()` timing | `waitFor({state:visible})` + `isDisabled()` check |
| `ats_jobadder_submit_failed` | 1 | "Want to apply later?" popup blocked submit | Popup dismissal in jobadder.ts |
| `unexpected_error` | 1 | Unknown |  |

---

## Fixes Applied (2026-05-25)

### 1. SEEK "You applied" detection (`lib/platforms/seek.ts`)
Before looking for the Apply button, now checks `text=You applied`. Returns `already_applied` skip reason.
`apply.ts` then adds the jobId to `applied_jobs.json` so future runs skip immediately.

### 2. SEEK "no longer advertised" detection (`lib/platforms/seek.ts`)
Detects `text=This job is no longer advertised`. Returns `job_no_longer_advertised` skip.
`apply.ts` adds to `blocked_jobs.json` (permanent skip list).

### 3. SEEK profile incomplete → blocked list (`lib/platforms/seek.ts` + `scripts/apply.ts`)
`validation_still_blocked` renamed to `seek_profile_incomplete`. When this fires, `apply.ts`
adds the job to `blocked_jobs.json`. Prevents 3–4 wasted retries per run.

### 4. Workday "Start Your Application" modal (`lib/ats/workday.ts`)
Added `dismissStartYourApplicationModal()` called after initial Apply click AND at the start
of each wizard loop iteration. Clicks "Apply Manually" → "Use My Last Application" → "Autofill".

### 5. PageUp consent checkbox (`lib/ats/pageup.ts`)
Added `tickConsentCheckboxes()` called before each Next/Submit attempt. Regex:
`/by continuing|i agree|i accept|terms|privacy|consent|acknowledge/i`.

### 6. JobAdder popup dismissal (`lib/ats/jobadder.ts`)
Dismisses "Want to apply later?" / save-for-later popups at the start of the handler.
Selectors: `[aria-label="Close"]`, `"No thanks"`, `"No, continue"`, `.modal-header button.close`.

### 7. Teamtailor submit reliability (`lib/ats/teamtailor.ts`)
Changed `isVisible()` → `waitFor({state:"visible"})`, added `scrollIntoViewIfNeeded()`,
`isDisabled()` check with fallback to tick ALL checkboxes, and `click({force:true})`.

### 8. `blocked_jobs.json` (`scripts/apply.ts`)
New persistent skip list for jobs that can never be auto-applied to. Checked alongside
`applied_jobs.json` at the start of every job visit. Committed to repo by CI.

---

## Expected improvement

| Category | Before | After (estimate) |
|----------|--------|-----------------|
| Workday failures | 7/run | ~1–2 (edge cases) |
| PageUp failures | 9/run | ~1–2 |
| JobAdder failures | 1/run | 0 |
| Teamtailor failures | 1/run | 0 |
| "You applied" revisits | ~20+/run | 0 (added to applied_jobs) |
| Profile-blocked retries | 6–8/run | 0 (blocked_jobs) |
| **Estimated apply rate** | ~1% | ~5–8% |

---

## Still unresolved

- `ats_unknown_provider` (14/run): Suncorp/Duck Creek, Allianz, Citi, Glencore, HCL. Need to capture redirect URLs to identify ATS patterns.
- `seenThisRun` dedup root cause: added `logger.info` for dedup hits to verify in next CI run logs.
- SEEK profile incomplete: user must update their SEEK profile to unlock the 2 permanently blocked jobs (AI Solutions Architect @ Marlin Human Capital, Project Manager @ The Recruitment Company).
