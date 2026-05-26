import { test as setup, expect } from "@playwright/test";

/**
 * One-shot login that all specs reuse. Saves cookies + localStorage to a
 * file that `playwright.config.ts` references via `storageState`. Replaces
 * the previous "every spec logs in" pattern which was hitting login 18+
 * times per run and racing the Better Auth + IP-rate-limit + lockout
 * gates under burst.
 */

const SUPERADMIN_EMAIL = "ali@loadless.ai";
const SUPERADMIN_PASSWORD = "loadless";

const AUTH_FILE = "tests/e2e/.auth/superadmin.json";

setup("authenticate as superadmin", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', SUPERADMIN_EMAIL);
  await page.fill('input[name="password"]', SUPERADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL(/\/(inbox|admin)/, { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  // Sanity-check the session cookie was set before we persist storage.
  await expect(page.locator("body")).not.toBeEmpty();
  await page.context().storageState({ path: AUTH_FILE });
});
