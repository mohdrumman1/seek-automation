import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,
  reporter: [['html', { open: 'on-failure' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    // Unit tests — no browser needed
    {
      name: 'unit',
      testMatch: ['**/tracker.spec.ts'],
      use: {},
    },
    // Browser tests
    { name: 'chromium', testMatch: ['**/example.spec.ts'], use: { ...devices['Desktop Chrome'] } },
  ],
});
