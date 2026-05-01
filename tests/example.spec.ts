import { test, expect } from '@playwright/test';

// Smoke test for your own app. Set BASE_URL in .env and remove the skip.
test.skip('homepage loads and has a title', async ({ page }) => {
  await page.goto('/');
  const title = await page.title();
  expect(title.length).toBeGreaterThan(0);
  console.log(`Page title: ${title}`);
});

// Example: test a specific URL outside of baseURL
test('seek.com.au is reachable', async ({ page }) => {
  await page.goto('https://www.seek.com.au');
  await expect(page).toHaveTitle(/SEEK/i);
});
