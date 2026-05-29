import { Page } from '@playwright/test';
import { ResumeVariant } from '../resume-selector';

export interface CrawlerJobLink {
  url: string;
  title?: string;
  jobId: string;
}

export interface CrawlerSearch {
  name: string;
  url: string;
  resumeVariant: ResumeVariant;
}

export interface CompanyCrawler {
  name: string;
  searches: CrawlerSearch[];
  getJobLinks(page: Page, searchUrl: string): Promise<CrawlerJobLink[]>;
}
