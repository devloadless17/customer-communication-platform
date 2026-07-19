import { test, expect, type Page } from "@playwright/test";

import { db, appAdmin, pollUntil } from "../_helpers/db";
import { setConversationStatus, createWorkflow, publishWorkflow, createOutboundWebhook } from "../_helpers/api";

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
  // Workflows + outbound webhooks created by the automation-wiring tests.
  await db().workflow.deleteMany({ where: { teamId, name: { contains: RUN } } });
  await db().outboundWebhook.deleteMany({ where: { teamId, name: { contains: RUN } } });
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
  const launcher = page.locator("button.launch");
  await launcher.waitFor({ state: "attached", timeout: 15_000 });
  // Open the panel — unless it auto-reopened from a persisted open-state (then
  // the launcher is hidden). Wait until either the composer or the pre-chat form
  // is visible so callers can interact immediately.
  if (await launcher.isVisible().catch(() => false)) {
    await launcher.click().catch(() => undefined);
  }
  await page
    .locator(".composer textarea, .form input")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
}

/** Fill/dismiss the optional pre-chat form if it's showing. */
async function pastPreChat(page: Page, email?: string): Promise<void> {
  const start = page.getByText("Start chat");
  if (await start.isVisible().catch(() => false)) {
    if (email) await page.locator(".form input").first().fill(email);
    await start.click();
  }
}

test("settings UI: create, list, and show the embed snippet", async ({ page }) => {
  await page.goto(`${WEB_ORIGIN}/settings/webchatwidget`);
  // The seeded widget shows in the list.
  await expect(page.getByText(WIDGET_NAME).first()).toBeVisible({ timeout: 20_000 });

  // Create a second widget via the UI (exercises the admin POST).
  await page.getByRole("button", { name: /New widget/i }).click();
  // The embed snippet renders a public key for the newly-selected widget.
  const snippet = page.locator("code", { hasText: "data-webchat-key" }).first();
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  const text = (await snippet.innerText()) ?? "";
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
    const input = visitor.locator(".composer textarea");
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

    // Attribution: the conversation is stamped with its source widget.
    // POLL, don't read once. The message row above is committed inside
    // `ingestEvents`, but the widget stamp is a SEPARATE updateMany that runs
    // after ingest returns — so the message poll can win the race and observe
    // `webchatWidgetId` still null. Asserting on a single read made this test
    // flaky (~1 in 3 locally).
    const conv = await pollUntil(
      async () => {
        const c = await db().conversation.findUnique({
          where: { id: msg.conversationId },
          select: { webchatWidgetId: true, contactId: true, channel: true },
        });
        return c?.webchatWidgetId ? c : null;
      },
      { timeoutMs: 20_000, label: "conversation stamped with webchatWidgetId" },
    );
    expect(conv.channel).toBe(CHANNEL);
    expect(conv.webchatWidgetId).toBe(widgetId);
    if (conv.contactId) createdContactIds.add(conv.contactId);

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

test("refresh mid-chat restores the thread and reopens the panel", async ({ browser }) => {
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  try {
    await mountWidget(visitor, PUBLIC_KEY);
    await pastPreChat(visitor);
    const msg = `refresh survives ${RUN}`;
    await visitor.locator(".composer textarea").fill(msg);
    await visitor.locator(".composer textarea").press("Enter");
    const landed = await pollUntil(
      async () =>
        db().message.findFirst({
          where: { teamId, channel: CHANNEL, direction: "in", body: msg },
          select: { conversationId: true },
        }),
      { timeoutMs: 20_000, label: "message before refresh" },
    );
    const conv = await db().conversation.findUnique({
      where: { id: landed.conversationId },
      select: { contactId: true },
    });
    if (conv?.contactId) createdContactIds.add(conv.contactId);

    // Reload the page (localStorage keeps visitorId + open-state) and re-mount:
    // the conversation resumes from server history and the panel auto-reopens.
    await mountWidget(visitor, PUBLIC_KEY);
    await expect(visitor.locator(".bubble", { hasText: msg })).toBeVisible({ timeout: 15_000 });
  } finally {
    await ctx.close();
  }
});

test("agent reply shows the agent's name and is marked read", async ({ browser, request }) => {
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  try {
    await mountWidget(visitor, PUBLIC_KEY);
    await pastPreChat(visitor);
    const msg = `receipts ${RUN}`;
    await visitor.locator(".composer textarea").fill(msg);
    await visitor.locator(".composer textarea").press("Enter");
    const landed = await pollUntil(
      async () =>
        db().message.findFirst({
          where: { teamId, channel: CHANNEL, direction: "in", body: msg },
          select: { conversationId: true },
        }),
      { timeoutMs: 20_000, label: "receipts inbound" },
    );
    const conv = await db().conversation.findUnique({
      where: { id: landed.conversationId },
      select: { contactId: true },
    });
    if (conv?.contactId) createdContactIds.add(conv.contactId);

    const reply = `named reply ${RUN}`;
    const resp = await request.post(`${WEB_ORIGIN}/api/messages`, {
      data: { conversationId: landed.conversationId, body: reply },
    });
    expect(resp.ok()).toBeTruthy();

    // The widget attributes the reply to the agent (ensureAppAdmin → "E2E Admin").
    await expect(visitor.locator(".sname", { hasText: "E2E Admin" })).toBeVisible({ timeout: 15_000 });
    await expect(visitor.locator(".bubble", { hasText: reply })).toBeVisible();

    // Panel is open + visible → the widget reports read → agent-side "Seen".
    await pollUntil(
      async () => {
        const m = await db().message.findFirst({
          where: { conversationId: landed.conversationId, direction: "out", body: reply },
          select: { status: true },
        });
        return m?.status === "read" ? m : null;
      },
      { timeoutMs: 15_000, label: "outbound read receipt" },
    );
  } finally {
    await ctx.close();
  }
});

test("closing shows a notice; a new message reopens the thread", async ({ browser, request }) => {
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  try {
    await mountWidget(visitor, PUBLIC_KEY);
    await pastPreChat(visitor);
    const msg = `closing ${RUN}`;
    await visitor.locator(".composer textarea").fill(msg);
    await visitor.locator(".composer textarea").press("Enter");
    const landed = await pollUntil(
      async () =>
        db().message.findFirst({
          where: { teamId, channel: CHANNEL, direction: "in", body: msg },
          select: { conversationId: true },
        }),
      { timeoutMs: 20_000, label: "closing inbound" },
    );
    const conv = await db().conversation.findUnique({
      where: { id: landed.conversationId },
      select: { contactId: true },
    });
    if (conv?.contactId) createdContactIds.add(conv.contactId);

    await setConversationStatus(request, landed.conversationId, "closed");
    await expect(visitor.locator(".sys.closed")).toBeVisible({ timeout: 15_000 });

    // A new message reopens the conversation server-side.
    await visitor.locator(".composer textarea").fill(`reopen ${RUN}`);
    await visitor.locator(".composer textarea").press("Enter");
    await pollUntil(
      async () => {
        const c = await db().conversation.findUnique({
          where: { id: landed.conversationId },
          select: { status: true },
        });
        return c && c.status !== "closed" ? c : null;
      },
      { timeoutMs: 15_000, label: "reopened after new message" },
    );
  } finally {
    await ctx.close();
  }
});

/** Inject the widget with custom data-* attributes (deploy modes). */
async function injectWidget(page: Page, extra: Record<string, string>): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/webchat/test.html`);
  await page.evaluate(
    ({ key, api, base, extra }) => {
      const s = document.createElement("script");
      s.src = `${base}/widget.js`;
      s.setAttribute("data-webchat-key", key);
      s.setAttribute("data-webchat-api", api);
      for (const [k, v] of Object.entries(extra)) s.setAttribute(k, v);
      document.body.appendChild(s);
    },
    { key: PUBLIC_KEY, api: API_ORIGIN, base: WEB_ORIGIN, extra },
  );
  await page.waitForSelector("#ccp-webchat-root", { state: "attached", timeout: 15_000 });
}

test("deploy mode: launcher off + JS API opens the chat", async ({ browser }) => {
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  try {
    await injectWidget(v, { "data-webchat-launcher": "off" });
    // No launcher bubble, and the panel isn't open yet.
    expect(await v.locator("button.launch").count()).toBe(0);
    await expect(v.locator(".composer textarea")).toBeHidden();
    // Any link/button can open it via the JS API.
    await v.waitForFunction(() => !!(window as unknown as { CCPWebchat?: { open?: () => void } }).CCPWebchat?.open, null, { timeout: 15_000 });
    await v.evaluate(() => (window as unknown as { CCPWebchat: { open: () => void } }).CCPWebchat.open());
    // Opens the panel; the pre-chat form (or composer) becomes visible.
    await expect(v.locator(".form input, .composer textarea").first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await ctx.close();
  }
});

test("deploy mode: inline embed renders in a container (always open, no launcher)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  try {
    await v.goto(`${WEB_ORIGIN}/webchat/test.html`);
    await v.evaluate(
      ({ key, api, base }) => {
        const d = document.createElement("div");
        d.id = "ccp-inline";
        d.style.height = "520px";
        d.style.maxWidth = "440px";
        document.body.appendChild(d);
        const s = document.createElement("script");
        s.src = `${base}/widget.js`;
        s.setAttribute("data-webchat-key", key);
        s.setAttribute("data-webchat-api", api);
        s.setAttribute("data-webchat-target", "#ccp-inline");
        document.body.appendChild(s);
      },
      { key: PUBLIC_KEY, api: API_ORIGIN, base: WEB_ORIGIN },
    );
    await v.waitForSelector("#ccp-webchat-root", { state: "attached", timeout: 15_000 });
    // No launcher; the panel is mounted inside the container and open immediately.
    expect(await v.locator("button.launch").count()).toBe(0);
    await expect(v.locator(".composer textarea, .form input").first()).toBeVisible({ timeout: 15_000 });
    // The shadow host moved into our container.
    const inside = await v.evaluate(() => !!document.getElementById("ccp-inline")?.querySelector("#ccp-webchat-root"));
    expect(inside).toBe(true);
  } finally {
    await ctx.close();
  }
});

test("automation: a workflow triggers on a webchatwidget message and auto-replies into the widget", async ({ browser, request }) => {
  const marker = `wfmark${RUN}`;
  const reply = `auto-reply from workflow ${RUN}`;
  // Scope the trigger to our marker so it only fires for this test's message.
  const wf = await createWorkflow(request, {
    name: `E2E widget wf ${RUN}`,
    trigger: "message_received",
    triggerConditions: [{ field: "body", op: "contains", value: marker }],
    graph: {
      startNodeId: "n1",
      nodes: [{ id: "n1", type: "send_message", config: { body: reply } }],
      edges: [],
    } as never,
  });
  await publishWorkflow(request, wf.id);

  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  try {
    await mountWidget(v, PUBLIC_KEY);
    await pastPreChat(v);
    await v.locator(".composer textarea").fill(`Hello ${marker}`);
    await v.locator(".composer textarea").press("Enter");

    // The message_received workflow trigger fires for the webchatwidget message
    // and its send_message action delivers the auto-reply live into the widget.
    await expect(v.locator(".bubble", { hasText: reply })).toBeVisible({ timeout: 25_000 });

    // …and it's persisted as an outbound webchatwidget message (system-authored).
    const m = await pollUntil(
      async () =>
        db().message.findFirst({
          where: { teamId, channel: CHANNEL, direction: "out", body: reply },
          select: { conversationId: true, senderUserId: true },
        }),
      { timeoutMs: 25_000, label: "workflow auto-reply message" },
    );
    expect(m.senderUserId).toBeNull(); // automation send
    const conv = await db().conversation.findUnique({ where: { id: m.conversationId }, select: { contactId: true } });
    if (conv?.contactId) createdContactIds.add(conv.contactId);
  } finally {
    await ctx.close();
  }
});

test("automation: outbound webhook fires for a webchatwidget message with the channel identified", async ({ browser, request }) => {
  const wh = await createOutboundWebhook(request, {
    name: `E2E widget wh ${RUN}`,
    url: "https://webhook.invalid/ccp-e2e", // unreachable — we assert on the stored delivery payload, not receipt
    eventTypes: ["message.received"],
  });

  const body = `webhook probe ${RUN}`;
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  try {
    await mountWidget(v, PUBLIC_KEY);
    await pastPreChat(v);
    await v.locator(".composer textarea").fill(body);
    await v.locator(".composer textarea").press("Enter");

    // A delivery row is recorded (verbatim wire payload) even though the POST
    // fails. It must identify the channel as webchatwidget — the fix that
    // synthesizes a channel block for connection-less first-party channels.
    const delivery = await pollUntil(
      async () =>
        db().outboundWebhookDelivery.findFirst({
          where: { webhookId: wh.id, eventType: "message.received" },
          orderBy: { createdAt: "desc" },
          select: { payload: true },
        }),
      { timeoutMs: 25_000, label: "outbound webhook delivery for webchatwidget" },
    );
    const json = JSON.stringify(delivery.payload);
    expect(json).toContain("webchatwidget"); // channel block is populated, not null
    expect(json).toContain(body); // and it's our message

    const inbound = await db().message.findFirst({
      where: { teamId, channel: CHANNEL, direction: "in", body },
      select: { conversationId: true },
    });
    const conv = inbound && (await db().conversation.findUnique({ where: { id: inbound.conversationId }, select: { contactId: true } }));
    if (conv?.contactId) createdContactIds.add(conv.contactId);
  } finally {
    await ctx.close();
  }
});

test("history pagination: >50 messages replays the latest page + 'Load earlier' fetches older", async ({ browser }) => {
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  try {
    await mountWidget(v, PUBLIC_KEY);
    await pastPreChat(v);
    // One live message creates the conversation we can then backfill.
    const seed = `pagination seed ${RUN}`;
    await v.locator(".composer textarea").fill(seed);
    await v.locator(".composer textarea").press("Enter");
    const landed = await pollUntil(
      async () =>
        db().message.findFirst({
          where: { teamId, channel: CHANNEL, direction: "in", body: seed },
          select: { conversationId: true },
        }),
      { timeoutMs: 20_000, label: "pagination seed message" },
    );
    const conversationId = landed.conversationId;
    const conv = await db().conversation.findUnique({
      where: { id: conversationId },
      select: { contactId: true },
    });
    if (conv?.contactId) createdContactIds.add(conv.contactId);

    // Backfill 60 OLDER outbound messages (distinct timestamps in the past) so the
    // conversation has 61 total — more than one HISTORY_LIMIT (50) page.
    const base = Date.now() - 3_600_000;
    await db().message.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        teamId,
        conversationId,
        channel: CHANNEL as never,
        direction: "out" as never,
        externalId: `older-${RUN}-${i}`,
        body: `older ${i} ${RUN}`,
        timestamp: new Date(base + i * 1000),
      })),
    });

    // Reconnect: the gateway replays the newest 50 and flags hasMore, so the
    // oldest messages are absent and the "Load earlier" bar appears.
    await mountWidget(v, PUBLIC_KEY);
    const earlier = v.locator(".earlierbtn");
    await expect(earlier).toBeVisible({ timeout: 15_000 });
    await expect(v.locator(".bubble", { hasText: `older 0 ${RUN}` })).toHaveCount(0);

    // Fetch the older page. Scrolling the thread to the top is the real user
    // action here — the widget auto-loads on an upward scroll, and the
    // "Load earlier" button is the fallback for a thread too short to scroll.
    // (Clicking the button directly is NOT a stable way to test this: Playwright
    // scrolls it into view first, which is itself an upward scroll, so the
    // auto-load fires and re-flows the thread out from under the click.)
    await v.locator(".body").evaluate((n) => { n.scrollTop = 0; });
    await expect(v.locator(".bubble", { hasText: `older 0 ${RUN}` })).toBeVisible({ timeout: 15_000 });
  } finally {
    await ctx.close();
  }
});

test("broadcasts reject webchatwidget as a channel (not broadcastable)", async ({ request }) => {
  // A freeform broadcast on `webchatwidget` must fail validation — a website
  // visitor has no durable push address, so the channel isn't broadcastable.
  const resp = await request.post(`${WEB_ORIGIN}/api/broadcasts`, {
    data: {
      kind: "freeform",
      channel: "webchatwidget",
      bodyText: `should never send ${RUN}`,
      audience: { mode: "all" },
    },
  });
  expect(resp.status()).toBe(400);
  expect(JSON.stringify(await resp.json())).toContain("channel");
});
