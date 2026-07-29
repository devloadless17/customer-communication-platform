import { test as setup, expect } from "@playwright/test";

import { ensureAppAdmin } from "./_helpers/db";

/**
 * One-shot login for a REGULAR admin that the customer-app specs reuse.
 * Saves storageState to `tests/e2e/.auth/app-admin.json`.
 *
 * Why this exists (2026-06-10): the org-approval gate redirects super-admins
 * out of the customer app to the platform shell, so the superadmin can no
 * longer drive /inbox, /contacts, etc. This admin lives in the DEDICATED e2e
 * workspace (`e2e-app-ws` — see _helpers/db.ts), so every fixture keyed by
 * `appAdmin().workspaceId` is visible to it and no spec ever touches the
 * maintainer's real workspace. Platform specs still use the superadmin
 * storageState.
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
  // Assert the INBOX actually rendered, not merely that something did.
  //
  // This was `expect(body).not.toBeEmpty()`, and a Next 404 page has a
  // non-empty body — so on 2026-07-29, with a stale `.next` making every
  // authenticated route 404, this setup went green and saved that storageState
  // for all ~537 downstream specs. A gate that cannot tell "logged in" from
  // "the whole app is 404ing" is not a gate. The app rail is rendered by the
  // (app) layout for every signed-in user, so its presence proves the
  // authenticated shell resolved; the negative half proves we are not on an
  // error page that happens to sit at this URL.
  await expect(page.getByRole("navigation").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("This page could not be found.")).toHaveCount(0);
  await page.context().storageState({ path: AUTH_FILE });
});
