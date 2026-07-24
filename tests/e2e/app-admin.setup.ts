import { test as setup, expect } from "@playwright/test";

import { ensureAppAdmin } from "./_helpers/db";

/**
 * One-shot login for a REGULAR admin that the customer-app specs reuse.
 * Saves storageState to `tests/e2e/.auth/app-admin.json`.
 *
 * Why this exists (2026-06-10): the org-approval gate redirects super-admins
 * out of the customer app to the platform shell, so the superadmin can no
 * longer drive /inbox, /contacts, etc. This admin lives in the SAME (active)
 * team as the superadmin, so every fixture keyed by `superadminTeam().workspaceId`
 * is visible to it. Platform specs still use the superadmin storageState.
 */
const AUTH_FILE = "tests/e2e/.auth/app-admin.json";

setup("authenticate as app admin", async ({ page }) => {
  const { email, password } = await ensureAppAdmin();
  await page.goto("/login");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL(/\/inbox/, { timeout: 30_000 }),
    // Scoped to the form that owns the password field, NOT `button[type=
    // "submit"]`. Since "Continue with Google" was added it renders ABOVE the
    // password form (deliberately — the one-click path belongs above the fold),
    // and it is a submit button in its own form, so the bare selector matched
    // GOOGLE first and every login here navigated to accounts.google.com.
    page.locator('form:has(input[name="password"]) button[type="submit"]').click(),
  ]);
  await expect(page.locator("body")).not.toBeEmpty();
  await page.context().storageState({ path: AUTH_FILE });
});
