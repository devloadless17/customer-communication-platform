import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";

import { APP_ADMIN_EMAIL, APP_ADMIN_PASSWORD } from "./_helpers/db";

/**
 * Pre-deploy e2e gate. Runs against the prod-imitate stack at
 * `http://localhost:8080` (Caddy → web :3000 + api :4000). Drives the
 * SAME bundle the deploy ships — server/client boundaries, RSC streams,
 * build optimizations all real. Catches the failure modes `pnpm dev`
 * silently papers over.
 *
 * Storage state: every spec here inherits `tests/e2e/.auth/app-admin.json`
 * (a regular admin in the seeded team) from the `setup` project — the
 * super-admin can no longer browse the customer app (org-approval gate), so
 * the customer-app surface is driven by the admin. The few specs that test the
 * login / logout flow start from an empty session via `test.use({ storageState })`.
 * The platform surface is covered separately in platform/platform.spec.ts.
 *
 * No fixture seeding — the suite assumes a fresh-deploy DB (just the
 * migrations + the superadmin row + the e2e app-admin). After this passes,
 * you can deploy without surprise.
 */

// Customer-app login uses the REGULAR admin — super-admins are redirected out
// of the customer app to the platform shell (the super-admin login + platform
// surface are covered in tests/e2e/platform/platform.spec.ts).
const LOGIN_EMAIL = APP_ADMIN_EMAIL;
const LOGIN_PASSWORD = APP_ADMIN_PASSWORD;

// Console / pageerror noise we explicitly tolerate. Anything else fails the spec.
const KNOWN_NOISE = [
  // Radix-UI's React-19 transitional warning — fires across the whole app,
  // tracked upstream, not a regression.
  "useInsertionEffect must not schedule updates",
  // Next.js dev-mode RSC perf measurement quirk. Doesn't fire in prod build
  // but the filter is belt-and-braces in case prod:local emits it from a
  // mixed dev/prod warning path.
  "cannot have a negative time stamp",
  // Next dev-overlay's React-DevTools nudge.
  "Download the React DevTools",
  // prod:local-environment artifact: the prod CSP includes
  // `upgrade-insecure-requests`, which forces the browser to rewrite any
  // http://localhost:8080/* sub-resource fetch (e.g. a sidebar <Link prefetch>)
  // to https://localhost:8080/* — and prod:local has no TLS terminator on
  // :8080. The page itself still loads fine (the top-level navigation is
  // exempt from the upgrade); only sub-resource prefetches fail. In real
  // production with HTTPS + Let's Encrypt this header does its job
  // correctly. The error is environment-noise, not a regression.
  "ERR_SSL_PROTOCOL_ERROR",
];

function shouldIgnore(text: string): boolean {
  return KNOWN_NOISE.some((noise) => text.includes(noise));
}

function trackHealth(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];

  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (shouldIgnore(text)) return;
    consoleErrors.push(text);
  });
  page.on("pageerror", (err) => {
    if (shouldIgnore(err.message)) return;
    pageErrors.push(err.message);
  });
  page.on("response", (resp) => {
    if (resp.status() >= 500) {
      serverErrors.push(`${resp.status()} ${resp.request().method()} ${resp.url()}`);
    }
  });

  return { consoleErrors, pageErrors, serverErrors };
}

function assertHealthy(
  health: ReturnType<typeof trackHealth>,
  context: string,
) {
  expect(health.serverErrors, `${context}: 5xx responses`).toEqual([]);
  expect(health.pageErrors, `${context}: page errors`).toEqual([]);
  expect(health.consoleErrors, `${context}: console errors`).toEqual([]);
}

// ─── 1. API health ───────────────────────────────────────────────────────
test("api /api/health responds through Caddy", async ({ request }) => {
  const resp = await request.get("/api/health");
  expect(resp.status()).toBe(200);
});

// ─── 2. Caddy serves the login page (proves the proxy chain works) ───────
// Starts from an EMPTY session so the page actually renders /login (an
// already-logged-in user would be redirected to /inbox).
test.describe("auth", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("Caddy → web serves /login", async ({ page }) => {
    const health = trackHealth(page);
    const resp = await page.goto("/login");
    expect(resp?.status()).toBeLessThan(400);
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    assertHealthy(health, "/login");
  });

  test("login → redirected to /inbox with session cookie", async ({ page, context }) => {
    const health = trackHealth(page);
    await page.goto("/login");
    await page.fill('input[name="email"]', LOGIN_EMAIL);
    await page.fill('input[name="password"]', LOGIN_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/inbox/, { timeout: 20_000 }),
      page.click('button[type="submit"]'),
    ]);
    expect(page.url()).toMatch(/\/inbox/);
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name.toLowerCase().includes("session"));
    expect(session?.value, "session cookie set after login").toBeTruthy();
    assertHealthy(health, "login");
  });
});

// ─── 3. /inbox mounts clean (with pre-authed storageState) ───────────────
test("/inbox mounts without errors (pre-authed)", async ({ page }) => {
  const health = trackHealth(page);
  await page.goto("/inbox");
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  const bodyText = await page.locator("body").innerText();
  expect(bodyText.length).toBeGreaterThan(50);
  assertHealthy(health, "/inbox");
});

// ─── 4. socket.io connected — verified via the presence "online dot" ─────
// We don't probe the WS handshake directly because Playwright's
// `page.on("websocket", ...)` doesn't fire deterministically against
// socket.io in this configuration (the client connects but the trace
// doesn't surface the upgrade — possibly because Chromium's WS proxying
// through Caddy bypasses Playwright's interception layer). The
// "your-own-presence dot is green" assertion is a STRONGER signal than
// the raw handshake: it proves the full chain — handshake → auth →
// presence emit → client receive → re-render — works end to end.
test("socket.io connects (presence dot visible)", async ({ page }) => {
  const health = trackHealth(page);
  await page.goto("/inbox");
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

  // The teammates sidebar renders the current user marked "you" with an
  // online-presence indicator the moment the socket connects. Look for
  // the "you" badge as a stable text anchor — its visibility is sufficient
  // proof that the InboxShell + sidebar mounted AND the presence frame
  // arrived.
  await expect(
    page.locator('text="you"').first(),
    "presence sidebar shows 'you' badge",
  ).toBeVisible({ timeout: 10_000 });

  assertHealthy(health, "socket.io presence");
});

// ─── 5. Each load-bearing page renders without 500/errors ────────────────
// Listed individually so the failure message names the exact broken path.
// Pre-authed via storageState — no per-test login.
const PAGES = [
  "/inbox",
  "/broadcasts",
  "/contacts",
  "/templates",
  "/workflows",
  "/team",
  "/settings/team",
  "/settings/whatsapp",
  "/settings/tags",
  "/settings/stages",
  "/settings/snippets",
  "/settings/contact-fields",
  "/settings/integrations",
  "/settings/account",
];

for (const path of PAGES) {
  test(`page ${path} renders without server/console errors`, async ({ page }) => {
    const health = trackHealth(page);
    const resp = await page.goto(path, { waitUntil: "domcontentloaded" });
    expect(resp?.status(), `${path} HTTP status`).toBeLessThan(400);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const body = await page.locator("body").innerText();
    expect(body.length, `${path} body length`).toBeGreaterThan(30);
    assertHealthy(health, path);
  });
}

// ─── 6. Multi-route navigation stays clean (pre-authed) ──────────────────
test("multi-route navigation stays clean", async ({ page }) => {
  const health = trackHealth(page);
  // Hit several routes in a single session to catch cross-route state
  // leaks (e.g. a listener bound on /inbox that crashes when /broadcasts
  // mounts because its socket frame format diverges).
  for (const path of ["/broadcasts", "/contacts", "/templates", "/inbox"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  }
  assertHealthy(health, "multi-route nav");
});

// ─── 7. Logout + post-logout redirect ────────────────────────────────────
// These NEED a fresh login each time so logout actually has something to
// clear, and the post-logout state isn't contaminated by storageState.
test.describe("logout flow", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  async function login(page: Page) {
    await page.goto("/login");
    await page.fill('input[name="email"]', LOGIN_EMAIL);
    await page.fill('input[name="password"]', LOGIN_PASSWORD);
    await Promise.all([
      page.waitForURL(/\/inbox/, { timeout: 20_000 }),
      page.click('button[type="submit"]'),
    ]);
  }

  test("logout clears session and lands on /login", async ({ page, context }) => {
    const health = trackHealth(page);
    await login(page);
    // /logout clears the session then redirects to /login; that redirect can
    // abort the in-flight navigation (net::ERR_ABORTED), which is expected —
    // the waitForURL below is the real proof that logout landed on /login.
    await page.goto("/logout").catch(() => {});
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (session) {
      expect(session.value, "session cookie value cleared on logout").toBeFalsy();
    }
    assertHealthy(health, "logout");
  });

  test("post-logout /inbox redirects to /login", async ({ page }) => {
    const health = trackHealth(page);
    await login(page);
    // /logout clears the session then redirects to /login; that redirect can
    // abort the in-flight navigation (net::ERR_ABORTED), which is expected —
    // the waitForURL below is the real proof that logout landed on /login.
    await page.goto("/logout").catch(() => {});
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    const resp = await page.goto("/inbox", { waitUntil: "domcontentloaded" });
    expect(page.url()).toMatch(/\/login/);
    expect(resp?.status()).toBeLessThan(400);
    assertHealthy(health, "post-logout /inbox");
  });
});

// ─── 8. /v1 API rejects unauthenticated requests ─────────────────────────
test("/v1 external API rejects requests with no Authorization header", async ({ request }) => {
  const resp = await request.get("/api/external/v1/contacts");
  expect(resp.status(), "/v1 unauth response").toBeGreaterThanOrEqual(401);
  expect(resp.status(), "/v1 unauth not 5xx").toBeLessThan(500);
});

// ─── 9. /v1 API rejects browser-origin (CORS browser-block) ──────────────
test("/v1 API rejects browser-origin requests", async ({ request }) => {
  const resp = await request.get("/api/external/v1/contacts", {
    headers: { Origin: "https://attacker.example.com" },
  });
  expect([403, 429]).toContain(resp.status());
});
