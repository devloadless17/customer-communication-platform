import { test, expect } from "@playwright/test";

import { db, APP_ADMIN_EMAIL, ensureAppAdmin } from "./_helpers/db";

/**
 * Password recovery + the email-verification gate, driven through the real UI.
 *
 * Why through the browser: every defect this flow shipped with was invisible to
 * a unit test. `/forgot-password` returned 200 from the server and was still
 * unreachable, because the auth proxy 307'd it to `/login` — the exact screen
 * the user is stuck on. Only requesting the page finds that.
 *
 * NO REAL EMAIL IS EVER SENT. The mail seam's `isTestRun()` interlock
 * short-circuits `sendMail` before any credential is read whenever
 * NODE_ENV=test / VITEST / MAIL_DISABLE_SEND=1, and nothing below submits an
 * address that has an account. The Brevo quota belongs to the customer.
 *
 * POST BUDGET — read before adding a test here. `/forgot-password` is rate
 * limited to 5 POSTs per 10 minutes PER IP (proxy.ts), because it is
 * unauthenticated, accepts an arbitrary recipient and spends a 300/day quota.
 * Every step of the flow is a POST to that same path, so a full request →
 * submit-code round trip costs TWO. The whole file deliberately spends two, and
 * a retry doubles that. Adding a third flow here will not fail loudly — it will
 * 429, the form will silently not advance, and you will get a confusing
 * "element not found" on the code input. Properties that do not need a browser
 * (validation order, message uniformity) are asserted in
 * apps/api/test/password-recovery.spec.ts instead.
 *
 * RE-RUNNING LOCALLY. The window is FIXED, not sliding, and the limiter is an
 * in-memory map in the Next process — so two runs inside ten minutes share one
 * budget and the second fails with "Something broke. An unexpected response was
 * received from the server", which looks nothing like a rate limit. Either wait
 * (`curl -sD- -o/dev/null -X POST localhost:3000/forgot-password | grep -i
 * retry-after` gives the exact seconds) or restart `pnpm dev`, which clears the
 * map instantly. CI is unaffected: a fresh process starts with an empty map.
 */

// No account exists for this address, so the request sends nothing.
const NO_ACCOUNT = "definitely-not-a-user@e2e-invalid.test";

test.describe("the reset page is reachable by someone who cannot sign in", () => {
  test("serves 200 to an anonymous visitor, not a redirect to /login", async ({
    page,
    context,
  }) => {
    // No cookie at all — the state every locked-out user is in.
    await context.clearCookies();
    const res = await page.goto("/forgot-password");

    expect(res?.status(), "an auth gate here makes recovery impossible").toBe(200);
    await expect(page).toHaveURL(/\/forgot-password$/);
    await expect(page.getByRole("heading", { name: /reset your password/i })).toBeVisible();
  });

  test("is linked from the sign-in screen", async ({ page, context }) => {
    // The link used to be dead text ("Ask your admin to reset it") because
    // there was no self-serve flow. A recovery page nobody can find is the
    // same as no recovery page.
    await context.clearCookies();
    await page.goto("/login");
    await page.getByRole("link", { name: /forgot password/i }).click();
    await expect(page).toHaveURL(/\/forgot-password/);
  });
});

test.describe("account enumeration", () => {
  // ONE flow, two POSTs — the entire file's budget. See the header.
  test("reveals nothing about whether the account exists", async ({ page, context }) => {
    await context.clearCookies();
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(NO_ACCOUNT);
    await page.getByRole("button", { name: /send reset code/i }).click();

    // Advances to the code step exactly as it would for a real account. If this
    // ever renders "no account found", the box has become a membership oracle:
    // submit a list, learn who your competitor's customers are.
    await expect(page.getByLabel(/6-digit code/i)).toBeVisible();
    await expect(page.getByText(/no account|not found|unknown|doesn't exist/i)).toHaveCount(0);

    // And the failure message says nothing either. This address has no account
    // at all, yet it reports the same "wrong or expired" a real account with a
    // mistyped code gets — so a wrong code and a non-existent user are
    // indistinguishable.
    await page.getByLabel(/6-digit code/i).fill("000000");
    await page.getByLabel("New password", { exact: true }).fill("e2e-recovery-pw-1");
    await page.getByLabel(/confirm new password/i).fill("e2e-recovery-pw-1");
    await page.getByRole("button", { name: /set new password/i }).click();

    // Scoped to the form. A bare `getByRole("alert")` is a strict-mode
    // violation on any Next.js page: the App Router always renders
    // `#__next-route-announcer__` with role="alert", so the locator resolves to
    // two elements and the real message is never even examined.
    await expect(
      page.locator("form").getByRole("alert"),
    ).toContainText(/wrong or has expired/i);
  });
});

test.describe("the super-admin password reset is GONE", () => {
  test("the route no longer exists", async ({ request }) => {
    // Removed deliberately: it required an operator to choose a customer's
    // credential and hand it over out-of-band. 404 (not 401) is the assertion —
    // 401 would mean the route is still mounted and merely guarded.
    const res = await request.post(
      "/api/admin/teams/any-workspace/members/any-user/reset-password",
      { data: { newPassword: "irrelevant" }, failOnStatusCode: false },
    );
    expect(res.status()).toBe(404);
  });
});

test.describe("the email-verification gate", () => {
  test("bounces an unverified user out of the app", async ({ page }) => {
    await ensureAppAdmin();
    const user = await db().user.findUniqueOrThrow({
      where: { email: APP_ADMIN_EMAIL },
      select: { id: true, emailVerified: true },
    });

    // Flip to unverified, prove the bounce, then restore — the shared fixture
    // user is reused by every other spec in the suite.
    await db().user.update({ where: { id: user.id }, data: { emailVerified: false } });
    try {
      await page.goto("/inbox");
      // The UI check. The API-side gate (SessionGuard + all three socket paths)
      // is the real boundary and is asserted separately in vitest — a UI-only
      // check would leave every REST route and the socket open.
      await expect(page).toHaveURL(/\/verify/);
    } finally {
      await db().user.update({
        where: { id: user.id },
        data: { emailVerified: user.emailVerified },
      });
    }
  });
});
