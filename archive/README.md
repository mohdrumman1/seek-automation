# Archive

This directory contains the **legacy Python / Selenium** implementation of the
SEEK auto-apply bot. It is **no longer used in production** and is retained
only as a reference for behaviour that the TypeScript / Playwright version
inherited.

## Status

- **Active codebase**: TypeScript + Playwright, entry point `scripts/seek-apply.ts`.
- **This directory**: read-only. Do not modify. Do not import from `scripts/` or `lib/`.

## Why it was retired

1. Selenium's `window_handles` model caused recurring `NoSuchWindowException`
   crashes mid-session on SEEK's apply flow.
2. `WebElement.is_displayed()` raised `NoneType` errors on detached elements,
   killing the loop.
3. Python + Selenium has no first-class story for trace viewers, codegen, or
   network interception — all of which we use in the Playwright version.

The Playwright rewrite fixes (1) via `BrowserContext.waitForEvent('page')` and
(2) via `locator.isVisible().catch(() => false)`.

## If you need the old code

It currently lives in git history on `main` prior to the Phase 1 refactor.
If anything from it is moved into this directory later, leave a note here
describing what was moved and why.
