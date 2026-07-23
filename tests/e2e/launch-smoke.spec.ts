import { test, expect } from "@playwright/test";

/**
 * Launch smoke — every major route loads without a runtime error.
 *
 * Not a feature test. This is the sweep you want before putting real clients on
 * a build: 40 files changed across the API and the web app, and the failure mode
 * that matters is a page that throws on mount for a reason no unit test sees —
 * a missing provider, a null deref on a fresh workspace, a bad import.
 *
 * It asserts three things per route, all of them cheap:
 *   1. the server returned a page (no 500),
 *   2. React didn't throw during render (no error overlay / boundary),
 *   3. nothing was logged to console.error.
 *
 * Deliberately does NOT assert on content — content assertions belong in the
 * feature specs, and putting them here makes this fail for reasons that have
 * nothing to do with "can a client use the app".
 */

const ROUTES = [
  "/inbox",
  "/contacts",
  "/broadcasts",
  "/templates",
  "/tickets",
  "/flags",
  "/team",
  "/workflows",
  "/settings",
  "/settings/whatsapp",
  "/settings/channels",
  "/settings/tickets",
  "/organization",
  "/organization/members",
  "/organization/workspaces",
  "/account",
  "/docs/api",
];

for (const route of ROUTES) {
  test(`${route} loads clean`, async ({ page }) => {
    // Generous: a cold dev server compiles each route on first hit.
    test.setTimeout(120_000);

    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      // Browser-level noise that says nothing about our code: blocked media,
      // favicon, and React's own hydration-mismatch *warning* text is already
      // covered by the overlay check below.
      if (/favicon|ERR_BLOCKED|Failed to load resource/i.test(t)) return;
      // Next's hot-reload socket. It only exists in dev, and it drops whenever
      // the dev server recompiles or restarts — so it reports on the harness,
      // never on the page. Asserting against it makes this suite flaky for a
      // reason that cannot occur in production.
      if (/webpack-hmr|_next\/webpack|HMR/i.test(t)) return;
      errors.push(t.slice(0, 300));
    });
    page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));

    const res = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 90_000 });
    expect(res?.status(), `${route} HTTP status`).toBeLessThan(400);

    // Let client components mount — a throw on mount is the whole point.
    await page.waitForTimeout(2500);

    // Our own error boundary.
    //
    // NOT `locator("nextjs-portal")`: that element is Next's dev-tools
    // indicator and is present on EVERY page in dev, error or not — asserting
    // zero of it failed all 17 routes while the app was fine. The dev error
    // OVERLAY is a specific dialog inside that portal, so target it by role.
    await expect(page.getByText("Something went wrong", { exact: false })).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: /unhandled|runtime error|build error/i }),
    ).toHaveCount(0);

    expect(errors, `${route} console errors`).toEqual([]);
  });
}
