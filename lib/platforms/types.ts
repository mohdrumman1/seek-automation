// Phase 3: Platform abstraction types.
// Each platform (SEEK, Indeed, Glassdoor) implements JobPlatform.
// The main entry point (scripts/apply.ts) only talks to this interface,
// so adding a new platform never requires touching existing platform code.

import { Browser, BrowserContext, Page } from '@playwright/test';
import { ResumeVariant } from '../resume-selector';

export interface JobDetails {
  title: string;
  company: string;
  description: string;
  location: string;
  salaryText: string;
  workType: string;
}

export interface SearchConfig {
  name: string;
  url: string;
  resumeVariant: ResumeVariant;
}

export interface ApplyConfig {
  resumeVariant: ResumeVariant;
  searchName: string;
  baseCoverLetter: string;
  kb: Array<{ keywords: string[]; answer: string }>;
  /**
   * Called immediately before the real final-submit click (never before a
   * "Next"/"Continue" navigation step). Handles pacing delay + daily-cap
   * reservation. Returns false when the cap is reached — the caller must
   * skip the click and return a `daily_cap_reached` result instead.
   */
  beforeSubmit?: () => Promise<boolean>;
}

export interface ApplyResult {
  success: boolean;
  variant?: ResumeVariant;
  skipReason?: string;
  failureReason?: string;
  requiresManualReview?: boolean;
  atsProvider?: string;
  externalUrl?: string;
}

export interface JobPlatform {
  readonly name: string;
  readonly searches: SearchConfig[];

  /** Set up browser context with saved session. */
  authenticate(browser: Browser): Promise<BrowserContext>;

  /** Persist the current session after a run. */
  persistSession(context: BrowserContext): Promise<void>;

  /** True if the session has expired and re-auth is needed. */
  isSessionExpired(page: Page): Promise<boolean>;

  /** Return all job URLs from a search result page. */
  getJobLinks(page: Page): Promise<string[]>;

  /** Scrape job metadata from the job detail page. */
  getJobDetails(page: Page): Promise<JobDetails>;

  /**
   * Attempt to apply to the job currently loaded in `page`.
   * Receives `details` pre-fetched by the caller for tracking purposes.
   * Returns a structured result with a skipReason (job ineligible) or
   * failureReason (bot couldn't complete the form) when success is false.
   */
  applyToJob(
    page: Page,
    context: BrowserContext,
    details: JobDetails,
    config: ApplyConfig,
  ): Promise<ApplyResult>;
}
