import { test as setup, expect } from "@playwright/test";

/**
 * One-shot superadmin login reused by the PLATFORM specs. Saves storageState
 * to `tests/e2e/.auth/superadmin.json`.
 *
 * The super-admin lands on /platform (the platform shell), NOT /inbox — the
 * org-approval gate redirects super-admins out of the customer app entirely
 * (2026-06-10). Customer-app specs use the separate app-admin storageState.
 */

const SUPERADMIN_EMAIL = "ali@loadless.ai";
const SUPERADMIN_PASSWORD = "loadless";

const AUTH_FILE = "tests/e2e/.auth/superadmin.json";

setup("authenticate as superadmin", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', SUPERADMIN_EMAIL);
  await page.fill('input[name="password"]', SUPERADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL(/\/platform/, { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  // Sanity-check the session cookie was set before we persist storage.
  await expect(page.locator("body")).not.toBeEmpty();
  await page.context().storageState({ path: AUTH_FILE });
});
