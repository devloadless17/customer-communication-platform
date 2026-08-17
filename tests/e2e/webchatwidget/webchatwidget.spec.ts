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
const CHANNEL = "webchatwidget" as const;

// Unique per run so parallel/repeated runs don't collide, and cleanup is scoped.
const RUN = `e2e${Date.now().toString(36)}`;
const PUBLIC_KEY = `wc_pk_${RUN}${"0".repeat(20)}`.slice(0, 30 + RUN.length);
const WIDGET_NAME = `E2E Store ${RUN}`;
const VISITOR_MSG = `hello from a visitor ${RUN}`;
const VISITOR_EMAIL = `${RUN}@visitor.test`;
const AGENT_REPLY = `agent reply ${RUN}`;

let workspaceId = "";
let widgetId = "";
const createdContactIds = new Set<string>();
const createdWidgetIds = new Set<string>();

test.beforeAll(async () => {
  ({ workspaceId } = await appAdmin());
  // Seed the primary widget directly (deterministic key + pre-chat email field
  // so the visitor flow is reproducible). The admin API + settings UI are
  // exercised separately in the "settings UI" test below.
  const widget = await db().webchatWidget.create({
    data: {
      workspaceId,
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
  await db().workflow.deleteMany({ where: { workspaceId, name: { contains: RUN } } });
  await db().outboundWebhook.deleteMany({ where: { workspaceId, name: { contains: RUN } } });
  // Contacts cascade to their conversations + messages; widgets SetNull.
  for (const id of createdContactIds) {
    await db().contact.deleteMany({ where: { id, workspaceId } });
  }
  await db().contact.deleteMany({
    where: { workspaceId, identityChannel: CHANNEL, externalContactId: { startsWith: widgetId } },
  });
  for (const id of createdWidgetIds) {
    await db().webchatWidget.deleteMany({ where: { id, workspaceId } });
  }
  await db().webchatWidget.deleteMany({ where: { workspaceId, name: { contains: RUN } } });
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
  // Settings are grouped into tabs; the install snippet lives on the Install tab.
  await page.getByRole("tab", { name: "Install" }).click();
  // The embed snippet renders a public key for the newly-selected widget.
  const snippet = page.locator("code", { hasText: "data-webchat-key" }).first();
  await expect(snippet).toBeVisible({ timeout: 15_000 });
  const text = (await snippet.innerText()) ?? "";
  expect(text).toMatch(/wc_pk_[a-z0-9]+/);

  // Track the UI-created widget for cleanup (find the newest for this team).
  const newest = await db().webchatWidget.findFirst({
    where: { workspaceId, id: { not: widgetId } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (newest) createdWidgetIds.add(newest.id);
});

test("settings: AI auto-reply defaults OFF and the toggle persists to config", async ({ page }) => {
  const name = `AI Toggle ${RUN}`;
  const w = await db().webchatWidget.create({
    data: {
      workspaceId, name, publicKey: `wc_pk_ai${RUN}${"0".repeat(16)}`.slice(0, 40),
      allowedOrigins: [], config: {},
    },
    select: { id: true, config: true },
  });
  createdWidgetIds.add(w.id);
  // Default: a fresh widget is NOT AI-enabled (absent === off).
  expect((w.config as Record<string, unknown>).aiEnabled ?? false).toBe(false);

  await page.goto(`${WEB_ORIGIN}/settings/webchatwidget`);
  // Select this widget (a per-widget tab appears once the team has >1).
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("tab", { name: "Behavior" }).click();

  const aiToggle = page.getByRole("switch", { name: /AI auto-reply/ });
  await expect(aiToggle).toBeVisible({ timeout: 15_000 });
  await expect(aiToggle).toHaveAttribute("aria-checked", "false");
  await aiToggle.click();
  await expect(aiToggle).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: /Save changes/i }).click();

  const saved = await pollUntil(
    async () => {
      const row = await db().webchatWidget.findUnique({ where: { id: w.id }, select: { config: true } });
      const cfg = (row?.config ?? {}) as Record<string, unknown>;
      return cfg.aiEnabled === true ? cfg : null;
    },
    { timeoutMs: 15_000, label: "aiEnabled persisted" },
  );
  expect(saved.aiEnabled).toBe(true);
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
          where: { workspaceId, channel: CHANNEL, direction: "in", body: VISITOR_MSG },
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
    // Picking STAGES the file; sending is a second, deliberate action (so a
    // mis-click can't fire an irreversible message). Confirm the chip, then send.
    await expect(visitor.locator(".stg.on")).toBeAttached({ timeout: 10_000 });
    await visitor.locator("button.sbtn").click();

    // The image lands as a typed media message on a webchatwidget conversation.
    const media = await pollUntil(
      async () =>
        db().message.findFirst({
          where: { workspaceId, channel: CHANNEL, direction: "in", mediaKind: "image" },
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
          where: { workspaceId, channel: CHANNEL, direction: "in", body: msg },
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
          where: { workspaceId, channel: CHANNEL, direction: "in", body: msg },
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

test("AI disclosure: an AI-authored reply is labelled 'AI' in the widget", async ({ browser }) => {
  // The visitor must always know a bot answered (disclosure). An AI reply carries
  // no human senderUserId; the widget distinguishes it via the frame's `ai` flag,
  // which on history replay is sourced from AiMessageMetadata.aiGenerated.
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  try {
    await mountWidget(visitor, PUBLIC_KEY);
    await pastPreChat(visitor);
    const msg = `ai disclosure ${RUN}`;
    await visitor.locator(".composer textarea").fill(msg);
    await visitor.locator(".composer textarea").press("Enter");
    const landed = await pollUntil(
      async () =>
        db().message.findFirst({
          where: { workspaceId, channel: CHANNEL, direction: "in", body: msg },
          select: { conversationId: true },
        }),
      { timeoutMs: 20_000, label: "ai-disclosure inbound" },
    );
    const conv = await db().conversation.findUnique({
      where: { id: landed.conversationId },
      select: { contactId: true },
    });
    if (conv?.contactId) createdContactIds.add(conv.contactId);

    // Seed an AI-authored outbound reply the way the assistant would: no
    // senderUserId, provenance `ai-assistant/reply`, and the canonical
    // AiMessageMetadata.aiGenerated row history replay reads.
    const aiReply = `I can help with that — ${RUN}`;
    const aiMsg = await db().message.create({
      data: {
        workspaceId, conversationId: landed.conversationId, channel: CHANNEL,
        externalId: `ai_${RUN}_${Math.random().toString(36).slice(2)}`,
        body: aiReply, direction: "out", status: "sent",
        rawPayload: { sentVia: "ai-assistant/reply" },
      },
      select: { id: true },
    });
    await db().aiMessageMetadata.create({
      data: { workspaceId, messageId: aiMsg.id, aiGenerated: true },
    });

    // Re-mount → the widget resumes from server history, which must carry the AI
    // label (mountWidget re-injects the script; a bare reload would drop it).
    await mountWidget(visitor, PUBLIC_KEY);
    await expect(visitor.locator(".bubble", { hasText: aiReply })).toBeVisible({ timeout: 20_000 });
    // The "AI" disclosure badge on the sender-name row, and the distinct AI avatar.
    await expect(visitor.locator(".sname .aib")).toHaveText("AI");
    await expect(visitor.locator(".mr.in .av.aiav")).toBeVisible();
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
          where: { workspaceId, channel: CHANNEL, direction: "in", body: msg },
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

test("presence: agent sees the visitor Online while connected, then Left on disconnect", async ({ browser, page }) => {
  // The reported bug: the presence chip never appeared because the live frame only
  // fires on the visitor's connect/disconnect, which an agent opening the thread
  // later would miss. The fix seeds current presence on subscribe AND announces it
  // when a first-message conversation is created. This proves both directions.
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  try {
    await mountWidget(visitor, PUBLIC_KEY);
    await pastPreChat(visitor);
    const msg = `presence ${RUN}`;
    await visitor.locator(".composer textarea").fill(msg);
    await visitor.locator(".composer textarea").press("Enter");
    const landed = await pollUntil(
      async () =>
        db().message.findFirst({
          where: { workspaceId, channel: CHANNEL, direction: "in", body: msg },
          select: { conversationId: true },
        }),
      { timeoutMs: 20_000, label: "presence inbound" },
    );
    const conv = await db().conversation.findUnique({
      where: { id: landed.conversationId },
      select: { contactId: true },
    });
    if (conv?.contactId) createdContactIds.add(conv.contactId);

    // Agent opens the thread AFTER the visitor is already connected — the seed path.
    await page.goto(`${WEB_ORIGIN}/inbox/${landed.conversationId}`);
    await expect(page.getByText("Online", { exact: true })).toBeVisible({ timeout: 20_000 });

    // Visitor leaves → the agent's chip flips to "Left …" live.
    await ctx.close();
    await expect(page.getByText(/Left|Away/)).toBeVisible({ timeout: 20_000 });
  } finally {
    if (!visitor.isClosed()) await ctx.close();
  }
});

test("visitor 'Start a new conversation' records a timeline note on the fresh thread", async ({ browser }) => {
  // Deliberately starting over (⋯ → End chat → confirm) rotates the visitor
  // to a brand-new contact + conversation, and the fresh thread carries a
  // "visitor_started_conversation" note so the agent knows it's a restart.
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  try {
    await mountWidget(v, PUBLIC_KEY);
    await pastPreChat(v);
    const msg1 = `restart first ${RUN}`;
    await v.locator(".composer textarea").fill(msg1);
    await v.locator(".composer textarea").press("Enter");
    const convA = await pollUntil(
      () =>
        db().message.findFirst({
          where: { workspaceId, channel: CHANNEL, direction: "in", body: msg1 },
          select: { conversationId: true },
        }),
      { timeoutMs: 20_000, label: "restart first message" },
    );
    const ca = await db().conversation.findUnique({
      where: { id: convA.conversationId },
      select: { contactId: true },
    });
    if (ca?.contactId) createdContactIds.add(ca.contactId);

    // ⋯ → "End chat" → confirm. The session ends IN PLACE — a widget must never
    // reload the page hosting it — leaving an ended card whose "Start new chat
    // session" reconnects under the rotated visitor id. No re-mount needed.
    await v.locator('button.hx[aria-label="More options"]').click();
    await v.getByRole("menuitem", { name: "End chat" }).click();
    await v.locator("button.rcy").click();
    await expect(v.locator(".ended")).toContainText("Your chat session has ended.");
    await v.locator(".ended .cstart").click();
    await pastPreChat(v);
    const msg2 = `restart second ${RUN}`;
    await v.locator(".composer textarea").fill(msg2);
    await v.locator(".composer textarea").press("Enter");
    const convB = await pollUntil(
      () =>
        db().message.findFirst({
          where: { workspaceId, channel: CHANNEL, direction: "in", body: msg2 },
          select: { conversationId: true },
        }),
      { timeoutMs: 20_000, label: "restart second message" },
    );
    // A genuinely new thread, not the same one reopened.
    expect(convB.conversationId).not.toBe(convA.conversationId);
    const cb = await db().conversation.findUnique({
      where: { id: convB.conversationId },
      select: { contactId: true },
    });
    if (cb?.contactId) createdContactIds.add(cb.contactId);

    const note = await pollUntil(
      () =>
        db().conversationEvent.findFirst({
          where: { conversationId: convB.conversationId, kind: "visitor_started_conversation" },
          select: { id: true },
        }),
      { timeoutMs: 15_000, label: "restart timeline note" },
    );
    expect(note).toBeTruthy();
  } finally {
    await ctx.close();
  }
});

test("inline embed can hide the header for a bare 'just chat' surface (showHeader:false)", async ({ browser }) => {
  const w = await db().webchatWidget.create({
    data: {
      workspaceId, name: `NoHeader ${RUN}`, publicKey: `wc_pk_nh${RUN}${"0".repeat(16)}`.slice(0, 40),
      allowedOrigins: [], config: { showHeader: false },
    },
    select: { id: true, publicKey: true },
  });
  createdWidgetIds.add(w.id);

  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  try {
    await v.goto(`${WEB_ORIGIN}/webchat/test.html`);
    await v.evaluate(
      ({ key, api, base }) => {
        const d = document.createElement("div");
        d.id = "nh-host";
        d.style.height = "520px";
        d.style.maxWidth = "440px";
        document.body.appendChild(d);
        const s = document.createElement("script");
        s.src = `${base}/widget.js`;
        s.setAttribute("data-webchat-key", key);
        s.setAttribute("data-webchat-api", api);
        s.setAttribute("data-webchat-target", "#nh-host");
        document.body.appendChild(s);
      },
      { key: w.publicKey, api: API_ORIGIN, base: WEB_ORIGIN },
    );
    await v.waitForSelector("#ccp-webchat-root", { state: "attached", timeout: 15_000 });
    // Composer is usable, but the widget's header is hidden — a bare chat surface.
    // (Scope to the embed host: the demo page has its own <header> nav.)
    await expect(v.locator(".composer textarea, .form input").first()).toBeVisible({ timeout: 15_000 });
    await expect(v.locator("#nh-host header")).toBeHidden();
  } finally {
    await ctx.close();
  }
});

test("the sample demo page auto-loads the widget and connects (bubble + full-page)", async ({ browser }) => {
  // This is the page an operator shows a prospect from Settings → "Test on a sample
  // page". It must inject the REAL widget itself and connect with zero fiddling —
  // including on the dev stack, where the socket lives on a different port than the
  // app (the page's apiOverride handles that). If this breaks, every live demo does.
  const ctx = await browser.newContext();
  try {
    // Bubble mode: the page injects the widget from ?key=; it must connect and send.
    const v = await ctx.newPage();
    await v.goto(`${WEB_ORIGIN}/webchat/test.html?key=${PUBLIC_KEY}&mode=bubble`);
    await v.waitForSelector("#ccp-webchat-root", { state: "attached", timeout: 15_000 });
    // Open deterministically via the widget's own JS API (the page exposes it).
    await v.waitForFunction(
      () => !!(window as unknown as { CCPWebchat?: { open?: () => void } }).CCPWebchat?.open,
      null,
      { timeout: 15_000 },
    );
    await v.evaluate(() => (window as unknown as { CCPWebchat: { open: () => void } }).CCPWebchat.open());
    // Wait for the panel content to render before dismissing the pre-chat form.
    await v.locator(".composer textarea, .form input").first().waitFor({ state: "visible", timeout: 15_000 });
    await pastPreChat(v);
    const msg = `demo page ${RUN}`;
    await v.locator(".composer textarea").fill(msg);
    await v.locator(".composer textarea").press("Enter");
    const landed = await pollUntil(
      async () =>
        db().message.findFirst({
          where: { workspaceId, channel: CHANNEL, direction: "in", body: msg },
          select: { conversationId: true },
        }),
      { timeoutMs: 20_000, label: "demo-page bubble message" },
    );
    const conv = await db().conversation.findUnique({
      where: { id: landed.conversationId },
      select: { contactId: true },
    });
    if (conv?.contactId) createdContactIds.add(conv.contactId);

    // Full-page mode: the chat fills the viewport (help-center style) — mounted in
    // the full-page host, no floating launcher, composer ready immediately.
    const v2 = await ctx.newPage();
    await v2.goto(`${WEB_ORIGIN}/webchat/test.html?key=${PUBLIC_KEY}&mode=fullpage`);
    await v2.waitForSelector("#ccp-webchat-root", { state: "attached", timeout: 15_000 });
    expect(await v2.locator("button.launch").count()).toBe(0);
    await expect(v2.locator(".composer textarea, .form input").first()).toBeVisible({ timeout: 15_000 });
    const fullpageMounted = await v2.evaluate(
      () =>
        document.body.classList.contains("fullpage") &&
        !!document.getElementById("fullpage-host")?.querySelector("#ccp-webchat-root"),
    );
    expect(fullpageMounted).toBe(true);
    await v2.close();
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
          where: { workspaceId, channel: CHANNEL, direction: "out", body: reply },
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
      where: { workspaceId, channel: CHANNEL, direction: "in", body },
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
          where: { workspaceId, channel: CHANNEL, direction: "in", body: seed },
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
        workspaceId,
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

// ─────────────────────────────────────────────────────────────────────────────
// Regression tests for the 2026-07-20 hardening pass. Each one maps to a bug
// that shipped, so each is here to stop it coming back — not to restate the
// happy paths above.
// ─────────────────────────────────────────────────────────────────────────────

/** Stage a file in the composer without sending it (the picker is display:none). */
async function stageFile(page: Page, name: string, type: string, bytes: number[]): Promise<void> {
  await page.evaluate(
    async ({ name, type, bytes }) => {
      const sr = document.getElementById("ccp-webchat-root")!.shadowRoot!;
      const inp = sr.querySelector<HTMLInputElement>('input[type=file]')!;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
      inp.files = dt.files;
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
    },
    { name, type, bytes },
  );
}

test("regression: .webp sends as an IMAGE, not a blocked 'sticker'", async ({ browser }) => {
  // `kindFromMime` maps image/webp → "sticker" for the Meta channels (WhatsApp
  // stickers ARE webp), and webchatwidget's kind-set has no `sticker` — so every
  // .webp was rejected with "Website widget doesn't support sending stickers".
  // webp is Chrome's default "Save image as" format, so this hit constantly.
  const ctx = await browser.newContext();
  try {
    const v = await ctx.newPage();
    await mountWidget(v, PUBLIC_KEY);
    await pastPreChat(v, VISITOR_EMAIL);
    const caption = `webp caption ${RUN}`;
    // Minimal RIFF/WEBP header so the server's magic-byte sniff accepts it.
    await stageFile(v, "photo.webp", "image/webp", [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);
    await v.locator(".composer textarea").fill(caption);
    await v.locator("button.sbtn").click();

    const msg = await pollUntil(
      () => db().message.findFirst({ where: { workspaceId, body: caption }, select: { mediaKind: true, mediaMimeType: true } }),
      { timeoutMs: 25_000, label: "webp media message" },
    );
    expect(msg?.mediaMimeType).toBe("image/webp");
    expect(msg?.mediaKind).toBe("image"); // NOT "sticker"
    // …and it renders inline rather than falling through to the 📄 document row.
    await expect(v.locator(".media img")).toBeVisible({ timeout: 15_000 });
  } finally {
    await ctx.close();
  }
});

test("regression: picking a file STAGES it — send is a second, deliberate action", async ({ browser }) => {
  // Picking used to upload and send immediately, so a mis-click or stray Ctrl+V
  // fired an irreversible message into the agent's inbox with no caption.
  const ctx = await browser.newContext();
  try {
    const v = await ctx.newPage();
    await mountWidget(v, PUBLIC_KEY);
    await pastPreChat(v, VISITOR_EMAIL);
    await stageFile(v, "doc.pdf", "application/pdf", [37, 80, 68, 70, 45, 49, 46, 52]);

    await expect(v.locator(".stg.on")).toBeAttached();
    await expect(v.locator(".stg .nm")).toHaveText("doc.pdf");
    // Nothing sent yet: no upload progress bar, no message row for it.
    expect(await v.locator(".prog").count()).toBe(0);
    // Removing it clears the chip and re-disables send.
    await v.locator(".stg .x").click();
    await expect(v.locator(".stg.on")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("regression: an unsent draft survives a page refresh", async ({ browser }) => {
  // restoreDraft() only ran from onReady(), so a draft was invisible whenever the
  // socket handshake failed or the panel hadn't been opened yet.
  const ctx = await browser.newContext();
  try {
    const v = await ctx.newPage();
    await mountWidget(v, PUBLIC_KEY);
    await pastPreChat(v, VISITOR_EMAIL);
    const draft = `half-typed thought ${RUN}`;
    await v.locator(".composer textarea").fill(draft);
    await v.waitForTimeout(600); // debounced persist
    // Re-mount rather than page.reload(): mountWidget injects the <script> at
    // runtime, so a raw reload would come back with no widget at all.
    await mountWidget(v, PUBLIC_KEY);
    await expect(v.locator(".composer textarea")).toHaveValue(draft, { timeout: 15_000 });
  } finally {
    await ctx.close();
  }
});

test("regression: inline embed mounts into a container that appears LATE (SPA)", async ({ browser }) => {
  // The target was resolved with ONE querySelector at script time, so a
  // React/Next/Vue host that mounts its container after hydration got a warning
  // and a permanently invisible widget — and those hosts are the most likely
  // users of inline mode.
  const ctx = await browser.newContext();
  try {
    const v = await ctx.newPage();
    await v.goto(`${WEB_ORIGIN}/webchat/test.html`);
    await v.evaluate(
      ({ key, api, base }) => {
        const s = document.createElement("script");
        s.src = `${base}/widget.js`;
        s.setAttribute("data-webchat-key", key);
        s.setAttribute("data-webchat-api", api);
        s.setAttribute("data-webchat-target", "#late-container");
        document.body.appendChild(s);
        // Container arrives 2s after the widget script has already run.
        setTimeout(() => {
          const d = document.createElement("div");
          d.id = "late-container";
          d.style.height = "600px";
          document.body.appendChild(d);
        }, 2000);
      },
      { key: PUBLIC_KEY, api: API_ORIGIN, base: WEB_ORIGIN },
    );
    await expect
      .poll(
        () => v.evaluate(() => document.getElementById("ccp-webchat-root")?.parentElement?.id ?? ""),
        { timeout: 20_000 },
      )
      .toBe("late-container");
    await expect(v.locator(".panel.inline")).toBeAttached();
  } finally {
    await ctx.close();
  }
});

test("regression: the widget does not clobber a host page's own socket.io", async ({ browser }) => {
  // The vendored client is a UMD build, so loading it defines window.io. We used
  // to REUSE an existing window.io (adopting the host's version — a v2/v4
  // mismatch broke us silently) and to overwrite theirs when we loaded first.
  const ctx = await browser.newContext();
  try {
    const v = await ctx.newPage();
    await v.goto(`${WEB_ORIGIN}/webchat/test.html`);
    await v.evaluate(
      ({ key, api, base }) => {
        (window as unknown as Record<string, unknown>).io = function HOST_IO() { return "host"; };
        (window as unknown as Record<string, unknown>).__hostIo = (window as unknown as Record<string, unknown>).io;
        const s = document.createElement("script");
        s.src = `${base}/widget.js`;
        s.setAttribute("data-webchat-key", key);
        s.setAttribute("data-webchat-api", api);
        document.body.appendChild(s);
      },
      { key: PUBLIC_KEY, api: API_ORIGIN, base: WEB_ORIGIN },
    );
    await v.waitForSelector("#ccp-webchat-root", { state: "attached", timeout: 15_000 });
    await v.locator("button.launch").click().catch(() => undefined);
    await v.locator(".composer textarea, .form input").first().waitFor({ state: "visible", timeout: 15_000 });
    // Widget connected (composer usable) AND the host's global is untouched.
    expect(
      await v.evaluate(() => {
        const w = window as unknown as Record<string, { name?: string }>;
        return w.io === w.__hostIo && w.io?.name === "HOST_IO";
      }),
    ).toBe(true);
  } finally {
    await ctx.close();
  }
});

test("regression: transport falls back when WebSockets are unavailable", async ({ browser }) => {
  // Websocket-only meant any proxy blocking the upgrade left the visitor on
  // "Reconnecting…" forever. Note socket.io defaults `tryAllTransports` to FALSE,
  // so listing "polling" second does nothing without the flag — assert both the
  // flag AND that the polling transport actually carries a message end-to-end.
  const js = await (await fetch(`${WEB_ORIGIN}/widget.js`)).text();
  expect(js).toContain("tryAllTransports: true");

  const ctx = await browser.newContext();
  try {
    const v = await ctx.newPage();
    // Force polling-only by rewriting the transport list in the served script.
    // (A refused WS upgrade can't be simulated via routeWebSocket — it ACCEPTS
    // then closes, so engine.io concludes websocket works and retries it.)
    await v.route(`${WEB_ORIGIN}/widget.js`, async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace('transports: ["websocket", "polling"]', 'transports: ["polling"]');
      await route.fulfill({ response: res, body });
    });
    await mountWidget(v, PUBLIC_KEY);
    await pastPreChat(v, VISITOR_EMAIL);
    const msg = `sent over polling ${RUN}`;
    await v.locator(".composer textarea").fill(msg);
    await v.locator("button.sbtn").click();
    const row = await pollUntil(
      () => db().message.findFirst({ where: { workspaceId, body: msg }, select: { id: true } }),
      { timeoutMs: 25_000, label: "message sent over polling" },
    );
    expect(row).toBeTruthy();
  } finally {
    await ctx.close();
  }
});

test("regression: anonymous visitors stay OUT of the contacts directory, identified ones get in", async ({ browser }) => {
  // Widget visitors are chat sessions, not directory entries — a per-browser
  // token with no durable address. Directory membership is DERIVED from having a
  // phone or email, so self-identifying promotes automatically.
  const ctx = await browser.newContext();
  try {
    const v = await ctx.newPage();
    await mountWidget(v, PUBLIC_KEY);
    // Skip the pre-chat form → stays anonymous.
    const start = v.getByText("Start chat");
    if (await start.isVisible().catch(() => false)) await start.click();
    const msg = `anon visitor ${RUN}`;
    await v.locator(".composer textarea").fill(msg);
    await v.locator("button.sbtn").click();
    await pollUntil(
      () => db().message.findFirst({ where: { workspaceId, body: msg }, select: { id: true } }),
      { timeoutMs: 25_000, label: "anonymous visitor message" },
    );

    const directoryWhere = {
      workspaceId,
      identityChannel: CHANNEL,
      deletedAt: null,
      OR: [{ phoneNumber: { not: null } }, { email: { not: null } }],
    };
    const anonInDirectory = await db().contact.count({
      where: { ...directoryWhere, externalContactId: { startsWith: widgetId } },
    });
    const anonTotal = await db().contact.count({
      where: { workspaceId, identityChannel: CHANNEL, deletedAt: null, externalContactId: { startsWith: widgetId } },
    });
    expect(anonTotal).toBeGreaterThan(anonInDirectory); // at least one hidden
  } finally {
    await ctx.close();
  }
});

test("security: trust-on-first-use records the embed domain write-once", async ({ browser }) => {
  // The site key is public (it's in the page source), so an unlocked widget can be
  // lifted onto a phishing page. We can't demand a domain at onboarding without
  // breaking first-run, so we observe the first REAL domain and let Settings offer
  // a one-click lock. Must be write-once: otherwise an attacker origin could
  // overwrite the suggestion and launder its own domain in.
  const w = await db().webchatWidget.create({
    data: { workspaceId, name: `TOFU ${RUN}`, publicKey: `wc_pk_tofu${RUN}${"0".repeat(16)}`.slice(0, 40), allowedOrigins: [], config: {} },
    select: { id: true, publicKey: true },
  });
  createdWidgetIds.add(w.id);
  const seen = () =>
    db().webchatWidget.findUnique({ where: { id: w.id }, select: { firstSeenOrigin: true } });

  // 1. A loopback visit is a developer testing — must NOT be recorded.
  const local = await browser.newContext();
  const lp = await local.newPage();
  await mountWidget(lp, w.publicKey);
  await local.close();
  expect((await seen())?.firstSeenOrigin).toBeNull();

  // 2. A real site IS recorded. 3. A later, different origin must NOT overwrite it.
  // Driven at the DB layer the same way the gateway does (CAS on null), since
  // Playwright can't forge a cross-origin page for a domain it doesn't serve.
  await db().webchatWidget.updateMany({ where: { id: w.id, firstSeenOrigin: null }, data: { firstSeenOrigin: "acme-store.com" } });
  expect((await seen())?.firstSeenOrigin).toBe("acme-store.com");
  await db().webchatWidget.updateMany({ where: { id: w.id, firstSeenOrigin: null }, data: { firstSeenOrigin: "attacker.example" } });
  expect((await seen())?.firstSeenOrigin).toBe("acme-store.com"); // unchanged
});

test("the MINIFIED production artifact works (this is what customers load)", async ({ browser }) => {
  // `public/widget.js` is the readable source served in dev; `prebuild` emits
  // widget.min.js and a prod-only rewrite serves it. Nothing else exercises that
  // artifact, and a mangled build would break every customer site at once.
  const head = await fetch(`${WEB_ORIGIN}/widget.min.js`);
  test.skip(!head.ok, "widget.min.js not built — run `pnpm --filter @ccp/web exec node scripts/build-widget.mjs`");

  const ctx = await browser.newContext();
  try {
    const v = await ctx.newPage();
    await v.goto(`${WEB_ORIGIN}/webchat/test.html`);
    await v.evaluate(
      ({ key, api, base }) => {
        const s = document.createElement("script");
        s.src = `${base}/widget.min.js`;
        s.setAttribute("data-webchat-key", key);
        s.setAttribute("data-webchat-api", api);
        document.body.appendChild(s);
      },
      { key: PUBLIC_KEY, api: API_ORIGIN, base: WEB_ORIGIN },
    );
    await v.waitForSelector("#ccp-webchat-root", { state: "attached", timeout: 15_000 });
    await v.locator("button.launch").click().catch(() => undefined);
    await v.locator(".composer textarea, .form input").first().waitFor({ state: "visible", timeout: 15_000 });
    // The public API survives minification (host pages depend on these names).
    expect(
      await v.evaluate(() => {
        const api = (window as unknown as { CCPWebchat?: Record<string, unknown> }).CCPWebchat ?? {};
        return ["open", "close", "toggle", "isOpen", "mount", "on", "unreadCount"].every((k) => typeof api[k] === "function");
      }),
    ).toBe(true);
  } finally {
    await ctx.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-07-20 (later): pre-chat form rewrite, attachment policy, expand.
// ─────────────────────────────────────────────────────────────────────────────

test("regression: the pre-chat form is NOT re-shown to a returning visitor", async ({ browser }) => {
  // The gateway emits `ready` BEFORE `history`, but the client used to decide
  // whether to render the form inside onReady via hasThread() — which reads a
  // message map that is always empty at that instant. Every returning visitor was
  // therefore asked for their details again, with their existing thread rendered
  // underneath the form. Re-asking for information already given is a textbook chat
  // UX failure, and it happened on every page load.
  const w = await db().webchatWidget.create({
    data: {
      workspaceId, name: `Reask ${RUN}`, publicKey: `wc_pk_reask${RUN}${"0".repeat(16)}`.slice(0, 40),
      allowedOrigins: [],
      config: { preChatFields: [{ id: "f_e", label: "Email", type: "email", required: false }] },
    },
    select: { id: true, publicKey: true },
  });
  createdWidgetIds.add(w.id);

  const ctx = await browser.newContext();
  try {
    const v = await ctx.newPage();
    await mountWidget(v, w.publicKey);
    await expect(v.locator(".form")).toBeAttached({ timeout: 10_000 }); // first visit: asked
    await pastPreChat(v, VISITOR_EMAIL);
    const msg = `returning visitor ${RUN}`;
    await v.locator(".composer textarea").fill(msg);
    await v.locator("button.sbtn").click();
    await pollUntil(
      () => db().message.findFirst({ where: { workspaceId, body: msg }, select: { id: true } }),
      { timeoutMs: 25_000, label: "first message" },
    );

    // Come back: same browser, same visitor id, existing conversation.
    await mountWidget(v, w.publicKey);
    await expect(v.locator(".bubble", { hasText: msg })).toBeVisible({ timeout: 15_000 });
    expect(await v.locator(".form").count()).toBe(0); // NOT asked again
  } finally {
    await ctx.close();
  }
});

test("pre-chat form asks one field at a time with a step counter", async ({ browser }) => {
  const w = await db().webchatWidget.create({
    data: {
      workspaceId, name: `Stepped ${RUN}`, publicKey: `wc_pk_step${RUN}${"0".repeat(16)}`.slice(0, 40),
      allowedOrigins: [],
      config: {
        preChatFields: [
          { id: "s1", label: "Your name", type: "name", required: true },
          { id: "s2", label: "Email", type: "email", required: false },
        ],
      },
    },
    select: { id: true, publicKey: true },
  });
  createdWidgetIds.add(w.id);

  const ctx = await browser.newContext();
  try {
    const v = await ctx.newPage();
    await mountWidget(v, w.publicKey);
    await expect(v.locator(".form")).toBeAttached({ timeout: 10_000 });

    // One input, not the whole form at once.
    expect(await v.locator(".form input").count()).toBe(1);
    await expect(v.locator(".fcount")).toHaveText("1 of 2");
    // A required field blocks progress rather than failing silently.
    await v.locator("button.fnext").click();
    await expect(v.locator(".err")).toBeVisible();

    await v.locator(".fld input").fill("Ali Ahmad");
    await v.locator("button.fnext").click();
    await expect(v.locator(".fcount")).toHaveText("2 of 2");
    // The answered step collapses to a summary instead of staying a live input.
    await expect(v.locator(".fsumrow")).toContainText("Ali Ahmad");
    // The final step's action is "Start chat" even when the field is optional and
    // empty — skipping the last field IS starting the chat. ("Skip" is the label on
    // non-final optional steps.)
    await expect(v.locator("button.fnext")).toHaveText("Start chat");

    await v.locator(".fld input").fill("stepped@example.com");
    await v.locator("button.fnext").click();
    await expect(v.locator(".form")).toHaveCount(0, { timeout: 10_000 });
    await expect(v.locator(".composer textarea")).toBeVisible();

    // The identity actually landed — a stepped rewrite must not drop a field.
    const msg = `stepped done ${RUN}`;
    await v.locator(".composer textarea").fill(msg);
    await v.locator("button.sbtn").click();
    const row = await pollUntil(
      () => db().message.findFirst({ where: { workspaceId, body: msg }, select: { conversationId: true } }),
      { timeoutMs: 25_000, label: "stepped-form message" },
    );
    // POLLED, not read once: the gateway applies pre-chat identity AFTER the
    // message ingest commits (find-conversation → room join → presence →
    // widget stamp all await in between), so the message row can be visible
    // milliseconds before the contact carries the identity. A single read here
    // raced that window and flaked on a loaded box while the DB showed the
    // email landing right after.
    const contact = await pollUntil(
      async () => {
        const conv = await db().conversation.findUnique({
          where: { id: row.conversationId },
          select: { contact: { select: { name: true, email: true } } },
        });
        return conv?.contact.email ? conv.contact : null;
      },
      { timeoutMs: 15_000, label: "stepped-form identity applied" },
    );
    expect(contact.email).toBe("stepped@example.com");
    expect(contact.name).toBe("Ali Ahmad");
  } finally {
    await ctx.close();
  }
});

test("pre-chat: a custom (non identity) field lands on the contact's customFields + a definition", async ({
  browser,
}) => {
  // A field the org adds that isn't name/email/phone (type "text", e.g. "Company")
  // is real contact data — it must be stored on Contact.customFields keyed by a slug
  // of the label, and a ContactFieldDefinition must exist so it RENDERS in the panel.
  // The old code mapped every non-email/phone field onto `name`, silently dropping it.
  const w = await db().webchatWidget.create({
    data: {
      workspaceId, name: `Custom ${RUN}`, publicKey: `wc_pk_cf${RUN}${"0".repeat(16)}`.slice(0, 40),
      allowedOrigins: [],
      config: {
        preChatFields: [
          { id: "c1", label: "Your name", type: "name", required: true },
          // "Language" is a KNOWN person column → sets Contact.language directly.
          { id: "c2", label: "Language", type: "text", required: false },
          // "Company" is unknown → becomes a custom field + definition.
          { id: "c3", label: "Company", type: "text", required: false },
        ],
      },
    },
    select: { id: true, publicKey: true },
  });
  createdWidgetIds.add(w.id);

  const ctx = await browser.newContext();
  try {
    const v = await ctx.newPage();
    await mountWidget(v, w.publicKey);
    await expect(v.locator(".form")).toBeAttached({ timeout: 10_000 });

    await v.locator(".fld input").fill("Custom Person");
    await v.locator("button.fnext").click();
    await expect(v.locator(".fcount")).toHaveText("2 of 3");
    await v.locator(".fld input").fill("French");
    await v.locator("button.fnext").click();
    await expect(v.locator(".fcount")).toHaveText("3 of 3");
    await v.locator(".fld input").fill("Acme Corp");
    await v.locator("button.fnext").click();
    await expect(v.locator(".form")).toHaveCount(0, { timeout: 10_000 });

    const msg = `custom field done ${RUN}`;
    await v.locator(".composer textarea").fill(msg);
    await v.locator("button.sbtn").click();
    const row = await pollUntil(
      () => db().message.findFirst({ where: { workspaceId, body: msg }, select: { conversationId: true } }),
      { timeoutMs: 25_000, label: "custom-field message" },
    );
    // The unknown field lands under its slug key; the known field ("Language") sets
    // the person column directly (NOT a custom field); the identity field it shares
    // the form with must NOT be clobbered.
    const conv = await pollUntil(
      async () => {
        const c = await db().conversation.findUnique({
          where: { id: row.conversationId },
          select: { contact: { select: { name: true, firstName: true, lastName: true, language: true, customFields: true } } },
        });
        const cf = (c?.contact.customFields ?? {}) as Record<string, string>;
        return cf.company === "Acme Corp" && c?.contact.language === "French" ? c : null;
      },
      { timeoutMs: 15_000, label: "customFields + known field applied" },
    );
    expect(conv?.contact.name).toBe("Custom Person");
    // The name field also splits into first/last (first word → first, rest → last).
    expect(conv?.contact.firstName).toBe("Custom");
    expect(conv?.contact.lastName).toBe("Person");
    expect(conv?.contact.language).toBe("French");
    // The unknown field became a custom field with a definition (renders in panel)…
    const def = await db().contactFieldDefinition.findFirst({
      where: { workspaceId, key: "company" },
      select: { label: true },
    });
    expect(def?.label).toBe("Company");
    // …and the KNOWN field did NOT leak into customFields as a duplicate key.
    const cf = (conv?.contact.customFields ?? {}) as Record<string, string>;
    expect(cf.language).toBeUndefined();
  } finally {
    await ctx.close();
  }
});

test("attachment policy is enforced by the SERVER, not just the widget", async ({ browser, request }) => {
  // The widget hides buttons as a courtesy, but it runs on the visitor's machine —
  // so the policy has to hold against a client that ignores it entirely.
  const w = await db().webchatWidget.create({
    data: {
      workspaceId, name: `Policy ${RUN}`, publicKey: `wc_pk_pol${RUN}${"0".repeat(16)}`.slice(0, 40),
      allowedOrigins: [], config: { allowedMediaKinds: ["image"] },
    },
    select: { id: true, publicKey: true },
  });
  createdWidgetIds.add(w.id);

  // Raw upload, bypassing the widget completely.
  const refused = await request.post(`${API_ORIGIN}/api/widget/media?key=${w.publicKey}`, {
    headers: { origin: "https://policy.test" },
    multipart: { file: { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") } },
  });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error).toBe("media_kind_not_allowed");

  const allowed = await request.post(`${API_ORIGIN}/api/widget/media?key=${w.publicKey}`, {
    headers: { origin: "https://policy.test" },
    multipart: {
      file: {
        name: "pixel.png", mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
      },
    },
  });
  expect(allowed.ok()).toBe(true);

  // …and the widget reflects it: no mic (audio off), picker scoped to images.
  const ctx = await browser.newContext();
  try {
    const v = await ctx.newPage();
    await mountWidget(v, w.publicKey);
    // Explicit mimes, not `image/*`: the wildcard let the iOS picker offer HEIC
    // photos that the shared OK_MIME list then rejected (widget.js acceptAttr).
    await expect(v.locator('input[type=file]')).toHaveAttribute("accept", "image/jpeg,image/png,image/gif,image/webp");
  } finally {
    await ctx.close();
  }
});

test("visitor can drag-resize the panel, and the size survives a refresh", async ({ browser }) => {
  // The corner-chat default is what made media controls and images feel cramped;
  // sizing on demand beats a bigger default, which would make the widget more
  // intrusive for every visitor who never needs it. Replaced an expand/restore
  // toggle — one continuous gesture instead of two fixed sizes behind a button.
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  try {
    const v = await ctx.newPage();
    await mountWidget(v, PUBLIC_KEY);
    const width = (): Promise<number> => v.evaluate(`Math.round(document.getElementById("ccp-webchat-root").shadowRoot.querySelector(".panel").getBoundingClientRect().width)`);
    const narrow = await width();
    expect(narrow).toBeLessThan(450); // corner-chat default (~376, sub-pixel varies)

    // Drag the outer top corner away from the screen edge to grow the panel.
    const grip = await v.evaluate(`(() => {
      const r = document.getElementById("ccp-webchat-root").shadowRoot.querySelector(".rsz").getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`) as { x: number; y: number };
    await v.mouse.move(grip.x, grip.y);
    await v.mouse.down();
    await v.mouse.move(grip.x - 200, grip.y - 120, { steps: 8 });
    await v.mouse.up();
    await expect.poll(width).toBeGreaterThan(narrow + 150);
    const dragged = await width();

    await mountWidget(v, PUBLIC_KEY); // re-mount = fresh page load
    expect(Math.abs((await width()) - dragged)).toBeLessThanOrEqual(4); // persisted
  } finally {
    await ctx.close();
  }
});

test("identity: duplicate phone surfaces a link SUGGESTION (unverified), not an auto-merge", async ({ request }) => {
  // Same human, several browsers, each typing the same phone into the pre-chat box.
  // Each browser is its own vis_<uuid> = its own Contact, so the agent would
  // otherwise see duplicate people. We suggest linking (a human confirms) and flag
  // the match unverified — auto-merging an unverified value is the impersonation
  // hole the identity layer prevents.
  const PHONE = `9617${Date.now().toString().slice(-7)}`;
  const mk = async (name: string, channel: "whatsapp" | "webchatwidget", extra: Record<string, unknown>) => {
    const cust = await db().customer.create({ data: { workspaceId, name } });
    const c = await db().contact.create({
      data: { workspaceId, name, identityChannel: channel, customerId: cust.id, ...extra },
      select: { id: true },
    });
    createdContactIds.add(c.id);
    return c.id;
  };
  const widgetA = await mk(`w:visA ${RUN}`, "webchatwidget", { externalContactId: `wq:visA${RUN}`, phoneNumber: PHONE });
  await mk(`w:visB ${RUN}`, "webchatwidget", { externalContactId: `wq:visB${RUN}`, phoneNumber: PHONE });
  const real = await mk(`Real ${RUN}`, "whatsapp", { phoneNumber: PHONE });

  // From a widget contact: sees the other widget contact AND the real customer.
  const r1 = await request.get(`${WEB_ORIGIN}/api/customers/by-contact/${widgetA}/suggestions`);
  expect(r1.ok()).toBe(true);
  const s1 = (await r1.json()).suggestions as Array<{ contactId: string; verified: boolean; matchedOn: string }>;
  expect(s1.length).toBe(2);
  expect(s1.every((x) => x.matchedOn === "phone")).toBe(true);
  expect(s1.every((x) => x.verified === false)).toBe(true); // widget value = unverified

  // From the REAL customer: the widget contacts claiming their number show up.
  const r2 = await request.get(`${WEB_ORIGIN}/api/customers/by-contact/${real}/suggestions`);
  const s2 = (await r2.json()).suggestions as Array<{ verified: boolean }>;
  expect(s2.length).toBe(2);
  expect(s2.every((x) => x.verified === false)).toBe(true);

  // Confirm one link via the existing reversible endpoint; it drops off the list.
  const realCustomer = await db().contact.findUnique({ where: { id: real }, select: { customerId: true } });
  const linkRes = await request.post(`${WEB_ORIGIN}/api/customers/${realCustomer!.customerId}/link`, {
    data: { contactId: widgetA },
  });
  expect(linkRes.ok()).toBe(true);
  const r3 = await request.get(`${WEB_ORIGIN}/api/customers/by-contact/${real}/suggestions`);
  const s3 = (await r3.json()).suggestions as unknown[];
  expect(s3.length).toBe(1); // widgetA now the same person, only visB remains
});
