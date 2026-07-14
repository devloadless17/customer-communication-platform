import { test, expect, type Page } from "@playwright/test";

import { db, appAdmin, pollUntil } from "../_helpers/db";

/**
 * End-to-end for the website chat-widget channel (`webchatwidget`).
 *
 * Drives the REAL embeddable widget (Shadow DOM, Socket.io "/widget" namespace)
 * as an anonymous visitor in a fresh browser context, and verifies the full
 * loop against the running dev stack:
 *   1. Admin settings UI creates + lists widgets and shows the embed snippet.
 *   2. A visitor completes the pre-chat form, sends a message → it lands in the
 *      inbox as a `webchatwidget` conversation stamped with its source widget,
 *      and the self-asserted email folds onto the contact (identity).
 *   3. An agent reply is delivered live to the visitor's widget.
 *   4. A visitor image upload lands as a typed media message.
 *
 * Topology: web = E2E_BASE_URL (:3000), api = E2E_WIDGET_API (:4000). The widget
 * loads from the web origin and is pointed at the api via `data-webchat-api`
 * (the same override a CDN-hosted widget would use); its socket is WebSocket-only
 * so no browser CORS applies. Run in isolation (NOT the destructive full suite):
 *   E2E_BASE_URL=http://localhost:3000 npx playwright test tests/e2e/webchatwidget
 */

const WEB_ORIGIN = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const API_ORIGIN = process.env.E2E_WIDGET_API ?? "http://localhost:4000";
const CHANNEL = "webchatwidget";

// Unique per run so parallel/repeated runs don't collide, and cleanup is scoped.
const RUN = `e2e${Date.now().toString(36)}`;
const PUBLIC_KEY = `wc_pk_${RUN}${"0".repeat(20)}`.slice(0, 30 + RUN.length);
const WIDGET_NAME = `E2E Store ${RUN}`;
const VISITOR_MSG = `hello from a visitor ${RUN}`;
const VISITOR_EMAIL = `${RUN}@visitor.test`;
const AGENT_REPLY = `agent reply ${RUN}`;

let teamId = "";
let widgetId = "";
const createdContactIds = new Set<string>();
const createdWidgetIds = new Set<string>();

test.beforeAll(async () => {
  ({ teamId } = await appAdmin());
  // Seed the primary widget directly (deterministic key + pre-chat email field
  // so the visitor flow is reproducible). The admin API + settings UI are
  // exercised separately in the "settings UI" test below.
  const widget = await db().webchatWidget.create({
    data: {
      teamId,
      name: WIDGET_NAME,
      publicKey: PUBLIC_KEY,
      allowedOrigins: [],
      config: {
        welcomeMessage: "Hi! How can we help?",
        headerTitle: WIDGET_NAME,
        preChatFields: [{ id: "f_email", label: "Your email", type: "email", required: false }],
        suggestedQuestions: ["Pricing?", "Book a demo"],
      },
    },
    select: { id: true },
  });
  widgetId = widget.id;
  createdWidgetIds.add(widgetId);
});

test.afterAll(async () => {
  // Contacts cascade to their conversations + messages; widgets SetNull.
  for (const id of createdContactIds) {
    await db().contact.deleteMany({ where: { id, teamId } });
  }
  await db().contact.deleteMany({
    where: { teamId, identityChannel: CHANNEL, externalContactId: { startsWith: widgetId } },
  });
  for (const id of createdWidgetIds) {
    await db().webchatWidget.deleteMany({ where: { id, teamId } });
  }
  await db().webchatWidget.deleteMany({ where: { teamId, name: { contains: RUN } } });
});

/** Inject the real widget into a fresh visitor page, pointed at the api. */
async function mountWidget(page: Page, publicKey: string): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/webchat/test.html`);
  await page.evaluate(
    ({ key, api, base }) => {
      const s = document.createElement("script");
      s.src = `${base}/widget.js`;
      s.setAttribute("data-webchat-key", key);
      s.setAttribute("data-webchat-api", api);
      document.body.appendChild(s);
    },
    { key: publicKey, api: API_ORIGIN, base: WEB_ORIGIN },
  );
  // The host div is `display:inline` + empty (all:initial) so Playwright reads it
  // as hidden; wait on the launcher inside the (open) shadow root instead —
  // Playwright pierces open shadow DOM for CSS selectors.
  await page.waitForSelector("#ccp-webchat-root", { state: "attached", timeout: 15_000 });
  const launcher = page.locator("button.launcher");
  await launcher.waitFor({ state: "visible", timeout: 15_000 });
  await launcher.click();
}

test("settings UI: create, list, and show the embed snippet", async ({ page }) => {
  await page.goto(`${WEB_ORIGIN}/settings/webchatwidget`);
  // The seeded widget shows in the list.
  await expect(page.getByText(WIDGET_NAME).first()).toBeVisible({ timeout: 20_000 });

  // Create a second widget via the UI (exercises the admin POST).
  await page.getByRole("button", { name: /New widget/i }).click();
  // The embed snippet renders a public key for the newly-selected widget.
  const snippet = page.locator("code", { hasText: "data-webchat-key" });
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  const text = (await snippet.first().innerText()) ?? "";
  expect(text).toMatch(/wc_pk_[a-z0-9]+/);

  // Track the UI-created widget for cleanup (find the newest for this team).
  const newest = await db().webchatWidget.findFirst({
    where: { teamId, id: { not: widgetId } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (newest) createdWidgetIds.add(newest.id);
});

test("visitor → inbox → agent reply, with pre-chat identity + widget attribution", async ({
  browser,
  request,
}) => {
  const ctx = await browser.newContext(); // anonymous visitor — no auth
  const visitor = await ctx.newPage();
  try {
    await mountWidget(visitor, PUBLIC_KEY);

    // Pre-chat form (email field, optional). Fill it, then start.
    const email = visitor.locator(".form input");
    await expect(email.first()).toBeVisible({ timeout: 15_000 });
    await email.first().fill(VISITOR_EMAIL);
    await visitor.getByText("Start chat").click();

    // Send a message.
    const input = visitor.locator(".composer input[type=text]");
    await expect(input).toBeVisible();
    await input.fill(VISITOR_MSG);
    await input.press("Enter");

    // It landed in the inbox as a webchatwidget message.
    const msg = await pollUntil(
      async () =>
        db().message.findFirst({
          where: { teamId, channel: CHANNEL, direction: "in", body: VISITOR_MSG },
          select: { id: true, conversationId: true },
        }),
      { timeoutMs: 20_000, label: "inbound webchatwidget message" },
    );

    const conv = await db().conversation.findUnique({
      where: { id: msg.conversationId },
      select: { webchatWidgetId: true, contactId: true, channel: true },
    });
    expect(conv?.channel).toBe(CHANNEL);
    // Attribution: the conversation is stamped with its source widget.
    expect(conv?.webchatWidgetId).toBe(widgetId);
    if (conv?.contactId) createdContactIds.add(conv.contactId);

    // Identity: the self-asserted email folded onto the contact.
    await pollUntil(
      async () => {
        const c = await db().contact.findUnique({
          where: { id: conv!.contactId },
          select: { email: true },
        });
        return c?.email === VISITOR_EMAIL ? c : null;
      },
      { timeoutMs: 10_000, label: "contact email from pre-chat" },
    );

    // Agent replies through the normal send path → delivered live to the widget.
    const resp = await request.post(`${WEB_ORIGIN}/api/messages`, {
      data: { conversationId: msg.conversationId, body: AGENT_REPLY },
    });
    expect(resp.ok()).toBeTruthy();

    await expect(
      visitor.locator(".bubble", { hasText: AGENT_REPLY }),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await ctx.close();
  }
});

test("visitor can send an image (media round-trip)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  try {
    await mountWidget(visitor, PUBLIC_KEY);

    // Skip the pre-chat form for this visitor (optional field) if it appears.
    const startBtn = visitor.getByText("Start chat");
    if (await startBtn.isVisible().catch(() => false)) await startBtn.click();

    // 1x1 transparent PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    await visitor
      .locator("input[type=file]")
      .setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: png });

    // The image lands as a typed media message on a webchatwidget conversation.
    const media = await pollUntil(
      async () =>
        db().message.findFirst({
          where: { teamId, channel: CHANNEL, direction: "in", mediaKind: "image" },
          orderBy: { timestamp: "desc" },
          select: { id: true, mediaKey: true, conversationId: true },
        }),
      { timeoutMs: 25_000, label: "inbound webchatwidget image message" },
    );
    expect(media.mediaKey).toBeTruthy();

    const c = await db().conversation.findUnique({
      where: { id: media.conversationId },
      select: { contactId: true },
    });
    if (c?.contactId) createdContactIds.add(c.contactId);
  } finally {
    await ctx.close();
  }
});
