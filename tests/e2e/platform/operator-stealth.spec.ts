import { test, expect } from "@playwright/test";

import { appAdmin, db } from "../_helpers/db";
import { superadminTeam } from "../_helpers/platform";

/**
 * OPERATOR MODE — stealth, proven in a real browser (the gap every earlier
 * verification pass flagged and none closed).
 *
 * Two live contexts against the SAME workspace: a real member watching their
 * inbox, and the operator entering, opening a thread, and typing into the
 * composer. The assertion is at the WIRE level — Playwright reads every
 * socket.io frame the MEMBER's tab receives — because that is strictly
 * stronger than pixels: a presence dot the CSS happens to hide would still
 * fail here, and a frame that never arrives can't be rendered by any future
 * UI change either.
 *
 * The stealth window is VIEW + TYPE only. Actions (a send, a status flip) are
 * deliberately visible and may carry the operator's id in their frames — that
 * is the design, not a leak — so none happen inside the window.
 *
 * Fixtures live in the shared `e2e-app-ws` (a real customer-shaped org) so the
 * member context can use the app-admin storageState; everything created here
 * is cleaned up in afterAll.
 */
test.use({ storageState: "tests/e2e/.auth/superadmin.json" });

let workspaceId = "";
let memberUserId = "";
let operatorUserId = "";
let conversationId = "";
let contactId = "";

test.beforeAll(async () => {
  ({ workspaceId, userId: memberUserId } = await appAdmin());
  ({ userId: operatorUserId } = await superadminTeam());

  const contact = await db().contact.create({
    data: {
      workspaceId,
      identityChannel: "whatsapp",
      phoneNumber: `1559${Date.now().toString().slice(-7)}`,
      name: "Stealth Customer",
    },
    select: { id: true },
  });
  contactId = contact.id;
  const conversation = await db().conversation.create({
    data: {
      workspaceId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      unreadCount: 1,
      lastMessageAt: new Date(),
      lastMessagePreview: "stealth fixture",
    },
    select: { id: true },
  });
  conversationId = conversation.id;
});

test.afterAll(async () => {
  // Leave operator mode — the durable Session.activeWorkspaceId outlives this
  // spec's contexts (see operator-identity.spec.ts for the full note).
  await db()
    .session.updateMany({
      where: { userId: operatorUserId },
      data: { activeWorkspaceId: null },
    })
    .catch(() => undefined);
  await db()
    .conversation.delete({ where: { id: conversationId } })
    .catch(() => undefined);
  await db()
    .contact.delete({ where: { id: contactId } })
    .catch(() => undefined);
});

test("a member's live tab receives NO frame naming the viewing operator", async ({
  browser,
  page,
}) => {
  // ── The member's watching tab ────────────────────────────────────────────
  const memberCtx = await browser.newContext({
    storageState: "tests/e2e/.auth/app-admin.json",
  });
  const memberPage = await memberCtx.newPage();

  // Capture every socket frame the member RECEIVES. socket.io text frames are
  // readable engine.io packets, so a plain substring scan is authoritative.
  const received: string[] = [];
  memberPage.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      if (typeof frame.payload === "string") received.push(frame.payload);
    });
  });

  await memberPage.goto("/inbox");
  // Wait until the member's own presence round-trips — proof the capture is
  // live and frames flow (the control half of the assertion).
  await expect
    .poll(() => received.some((f) => f.includes("presence:update")), {
      timeout: 15_000,
    })
    .toBe(true);
  const framesBeforeOperator = received.length;

  // ── The operator enters, watches, and types — never acts ────────────────
  const enter = await page.request.post("/api/admin/operator-access", {
    data: { workspaceId },
  });
  expect(enter.ok()).toBe(true);

  await page.goto(`/inbox/${conversationId}`);
  // The composer is where typing:start fires from. Type without sending.
  const composer = page.locator("textarea").first();
  await composer.waitFor({ state: "visible", timeout: 15_000 });
  await composer.pressSequentially("just looking, never sending", { delay: 30 });

  // Let every would-be frame (presence add, viewer broadcast, typing) travel.
  await memberPage.waitForTimeout(2_500);

  // ── The wire never named the operator ────────────────────────────────────
  const sinceOperator = received.slice(framesBeforeOperator).join("\n");
  expect(sinceOperator).not.toContain(operatorUserId);

  // And the member's unread badge state survived the operator's viewing: the
  // thread the operator has OPEN still counts unread server-side.
  const row = await db().conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { unreadCount: true },
  });
  expect(row.unreadCount).toBe(1);

  // Control for the control: the member's tab was genuinely live all along.
  expect(received.length).toBeGreaterThan(0);
  void memberUserId;

  await memberCtx.close();
});
