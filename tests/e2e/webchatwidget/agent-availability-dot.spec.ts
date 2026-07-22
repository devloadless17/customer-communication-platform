import { test, expect, type Browser, type Page } from "@playwright/test";
import { Prisma } from "@prisma/client";

import { db, appAdmin } from "../_helpers/db";
import { DAY_KEYS, type WorkHours } from "../../../packages/shared/src/work-hours";

/**
 * The widget's "an agent is available" dot.
 *
 * This dot is a PROMISE TO A CUSTOMER — "someone is here, ask your question".
 * It used to mean only "an agent has a browser tab open", so a teammate who was
 * busy, away, appear-offline, or off shift still lit it green and the visitor
 * waited on nobody. It also only ever recomputed on socket connect/disconnect,
 * so even "Appear offline" left the dot green until someone opened or closed a
 * tab.
 *
 * Both halves are covered here against the real widget over the real
 * `/widget` namespace:
 *   - the SEED a visitor gets on connect reflects availability, not just presence
 *   - a LIVE availability change pushes a fresh `agents` frame
 *   - working hours drive it too (an off-shift team shows as away)
 *
 * Run in isolation (not the destructive full suite):
 *   E2E_BASE_URL=http://localhost:3000 npx playwright test tests/e2e/webchatwidget/agent-availability-dot.spec.ts
 */

const WEB_ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const API_ORIGIN = process.env.E2E_WIDGET_API ?? "http://localhost:4000";
const TZ = "UTC";

const RUN = `dot${Date.now().toString(36)}`;
const PUBLIC_KEY = `wc_pk_${RUN}${"0".repeat(24)}`.slice(0, 34);

let workspaceId = "";
let adminUserId = "";
let widgetId = "";

/** A schedule that is definitely CLOSED right now (a window two days out). */
function closedNow(): WorkHours {
  const todayIdx = (new Date().getUTCDay() + 6) % 7;
  const farDay = DAY_KEYS[(todayIdx + 2) % 7]!;
  return { timezone: TZ, weekly: { [farDay]: [{ open: "09:00", close: "10:00" }] } };
}

test.beforeAll(async () => {
  ({ workspaceId, userId: adminUserId } = await appAdmin());
  const widget = await db().webchatWidget.create({
    data: {
      workspaceId,
      name: `Dot probe ${RUN}`,
      publicKey: PUBLIC_KEY,
      allowedOrigins: [],
      config: { welcomeMessage: "Hi!", headerTitle: `Dot probe ${RUN}` },
    },
    select: { id: true },
  });
  widgetId = widget.id;
});

test.afterAll(async () => {
  await db().workspace.update({ where: { id: workspaceId }, data: { workHours: Prisma.DbNull } });
  await db().user.updateMany({
    where: { workspaceMemberships: { some: { workspaceId } } },
    data: {
      availabilityStatus: "available",
      availabilityMessage: null,
      availabilityManualStatus: "available",
      availabilityManualMessage: null,
      availabilitySource: "manual",
      availabilitySetByUserId: null,
      availabilityOverrideUntil: null,
      workHoursMode: "inherit",
      workHours: Prisma.DbNull,
    },
  });
  await db().contact.deleteMany({
    where: { workspaceId, identityChannel: "webchatwidget", externalContactId: { startsWith: widgetId } },
  });
  await db().webchatWidget.deleteMany({ where: { id: widgetId } });
});

/**
 * Mount the real widget in a FRESH (unauthenticated) context and stream the
 * `agents` frames its socket receives. Reading raw WS frames keeps this honest:
 * it asserts what the server actually pushed, not a re-render.
 */
async function mountVisitor(
  browser: Browser,
): Promise<{ page: Page; dots: boolean[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const dots: boolean[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => {
      const payload = typeof f.payload === "string" ? f.payload : f.payload.toString();
      if (!payload.includes('"agents"')) return;
      const m = /"online"\s*:\s*(true|false)/.exec(payload);
      if (m) dots.push(m[1] === "true");
    });
  });

  await page.goto(`${WEB_ORIGIN}/webchat/test.html`);
  await page.evaluate(
    ({ key, api, base }) => {
      const s = document.createElement("script");
      s.src = `${base}/widget.js`;
      s.setAttribute("data-webchat-key", key);
      s.setAttribute("data-webchat-api", api);
      document.body.appendChild(s);
    },
    { key: PUBLIC_KEY, api: API_ORIGIN, base: WEB_ORIGIN },
  );
  await page.waitForSelector("#ccp-webchat-root", { state: "attached", timeout: 20_000 });
  const launcher = page.locator("button.launch");
  await launcher.waitFor({ state: "attached", timeout: 20_000 });
  // The widget connects its socket LAZILY, on panel open — mounting alone never
  // produces an `agents` frame. Open it (unless a persisted open-state already
  // did) and wait until the composer or pre-chat form is live.
  if (await launcher.isVisible().catch(() => false)) {
    await launcher.click().catch(() => undefined);
  }
  await page
    .locator(".composer textarea, .form input")
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  return { page, dots, close: () => context.close() };
}

/**
 * Open the agent app and wait until the SERVER has actually registered their
 * socket — the widget dot is derived from live presence, so a fixed sleep here
 * races a cold dev compile and makes every assertion below a coin flip. The
 * team-room `presence:update` naming this user is the server telling us it's
 * done.
 */
async function connectAgent(page: Page): Promise<void> {
  const seen: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => {
      const payload = typeof f.payload === "string" ? f.payload : f.payload.toString();
      if (payload.includes("presence:update")) seen.push(payload);
    });
  });
  // `domcontentloaded` + a generous timeout: /inbox is a heavy route and a cold
  // dev compile blows the 15s default. The presence frame below is the real
  // readiness signal anyway — waiting for `load` adds nothing.
  await page.goto("/inbox", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await expect
    .poll(() => seen.some((p) => p.includes(adminUserId)), {
      timeout: 60_000,
      intervals: [250],
    })
    .toBe(true);
}

/** The latest dot the server pushed, waited for. */
async function expectDot(dots: boolean[], want: boolean, why: string): Promise<void> {
  await expect
    .poll(() => (dots.length ? dots[dots.length - 1] : null), { timeout: 20_000, intervals: [250] })
    .toBe(want);
  expect(dots.length, why).toBeGreaterThan(0);
}

// Serial: the tests share one team's availability state, and each drives a real
// browser + a cold-compiled /inbox, so they need room beyond the 60s default.
test.describe.configure({ mode: "serial", timeout: 180_000 });

test("an ONLINE + AVAILABLE agent lights the dot", async ({ page, request, browser }) => {
  await request.put("/api/team/work-hours", { data: { workHours: null } });
  await request.patch("/api/users/me/availability", { data: { status: "available" } });

  // The agent's socket is what puts them in presence — open the real app.
  await connectAgent(page);

  const visitor = await mountVisitor(browser);
  await expectDot(visitor.dots, true, "seed frame on connect");
  await visitor.close();
});

test("a BUSY agent does NOT light it — the seed reflects availability, not tabs", async ({
  page,
  request,
  browser,
}) => {
  await connectAgent(page);
  await request.patch("/api/users/me/availability", { data: { status: "busy" } });

  const visitor = await mountVisitor(browser);
  // Same connected agent as the previous test — only their STATUS changed.
  await expectDot(visitor.dots, false, "seed frame while the only agent is busy");
  await visitor.close();
});

test("flipping availability pushes a LIVE frame to an already-open widget", async ({
  page,
  request,
  browser,
}) => {
  await connectAgent(page);
  await request.patch("/api/users/me/availability", { data: { status: "available" } });

  const visitor = await mountVisitor(browser);
  await expectDot(visitor.dots, true, "seed");

  // The regression this guards: before, the relay only ran on socket
  // connect/disconnect, so the dot stayed green after the last agent stepped
  // away and the visitor kept waiting on nobody.
  await request.patch("/api/users/me/availability", { data: { status: "away" } });
  await expectDot(visitor.dots, false, "live frame after the agent went away");

  await request.patch("/api/users/me/availability", { data: { status: "available" } });
  await expectDot(visitor.dots, true, "live frame after coming back");
  await visitor.close();
});

test("working hours drive the dot — an off-shift team reads as away", async ({
  page,
  request,
  browser,
}) => {
  await connectAgent(page);
  await request.patch("/api/users/me/availability", { data: { status: "available" } });

  const visitor = await mountVisitor(browser);
  await expectDot(visitor.dots, true, "on shift / no schedule");

  // Closing the org's shift resolves every member to `away`, which must reach
  // the visitor: nobody is going to answer until the next opening.
  await request.put("/api/team/work-hours", { data: { workHours: closedNow() } });
  await expectDot(visitor.dots, false, "live frame after the shift closed");

  await request.put("/api/team/work-hours", { data: { workHours: null } });
  await expectDot(visitor.dots, true, "live frame after the schedule was lifted");
  await visitor.close();
});
