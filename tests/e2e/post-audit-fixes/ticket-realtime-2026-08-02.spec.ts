import { expect, test, type Browser, type Page } from "@playwright/test";
import bcrypt from "bcrypt";

import { E2E_APP_ORG_ID, E2E_APP_WS_ID, db } from "../_helpers/db";

/**
 * "Nothing should need a refresh" — the realtime contract, driven as two real
 * browsers.
 *
 * The reported bug: an agent assigned a ticket had to refresh the page to see
 * it. Root cause: RESTRICTED agents (role=agent, visibility="assigned")
 * deliberately never join the workspace socket room, and every ticket frame
 * was emitted only to that room — HTTP said yes, the socket said nothing. The
 * fix co-targets each involved person's user room on the same de-duped emit.
 *
 * This spec is that bug end to end: a restricted agent logs in (context B), an
 * admin acts over HTTP (context A's request context), and every assertion is
 * about B's screen changing WITHOUT a reload.
 *
 *   pnpm exec playwright test tests/e2e/post-audit-fixes/ticket-realtime-2026-08-02.spec.ts
 */

const AGENT_EMAIL = "e2e-restricted-agent@loadless.test";
const AGENT_PASSWORD = "loadless";

async function seedRestrictedAgent(): Promise<{ userId: string }> {
  const d = db();
  const passwordHash = await bcrypt.hash(AGENT_PASSWORD, 10);
  const user = await d.user.upsert({
    where: { email: AGENT_EMAIL },
    create: {
      organizationId: E2E_APP_ORG_ID,
      name: "E2E Restricted Agent",
      email: AGENT_EMAIL,
      emailVerified: true,
    },
    update: { organizationId: E2E_APP_ORG_ID, deactivatedAt: null, emailVerified: true },
  });
  await d.workspaceMember.upsert({
    where: { userId_workspaceId: { userId: user.id, workspaceId: E2E_APP_WS_ID } },
    create: { userId: user.id, workspaceId: E2E_APP_WS_ID, role: "agent" },
    update: { role: "agent" },
  });
  await d.account.upsert({
    where: { providerId_accountId: { providerId: "credential", accountId: AGENT_EMAIL } },
    create: {
      userId: user.id,
      providerId: "credential",
      accountId: AGENT_EMAIL,
      password: passwordHash,
    },
    update: { password: passwordHash, userId: user.id },
  });
  return { userId: user.id };
}

/** A conversation to hang tickets on — seeded, not scavenged: the shared dev
 *  DB is wiped by other suites, and a spec that skips when the pantry is empty
 *  is a spec that silently stops guarding. */
async function seedConversation(): Promise<string> {
  const d = db();
  const stamp = Date.now();
  const contact = await d.contact.create({
    data: {
      workspaceId: E2E_APP_WS_ID,
      name: `RT Contact ${stamp}`,
      phoneNumber: `+96170${String(stamp).slice(-6)}`,
      identityChannel: "whatsapp",
    },
    select: { id: true },
  });
  const convo = await d.conversation.create({
    data: { workspaceId: E2E_APP_WS_ID, contactId: contact.id, channel: "whatsapp" },
    select: { id: true },
  });
  return convo.id;
}

async function loginAs(browser: Browser, email: string, password: string): Promise<Page> {
  const context = await browser.newContext({ storageState: undefined });
  const page = await context.newPage();
  await page.goto("/login", { timeout: 120_000, waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL(/\/(inbox|tickets)/, { timeout: 60_000 }),
    // Scoped to the password form — the Google button is a submit in its own
    // form ABOVE it (same trap auth.setup.ts documents).
    page.locator('form:has(input[name="password"]) button[type="submit"]').click(),
  ]);
  return page;
}

test.describe.configure({ mode: "serial" });

test("a RESTRICTED agent sees assignment, reply and reassignment live — no refresh", async ({
  browser,
  page: adminPage,
}) => {
  test.setTimeout(300_000);
  const { userId: agentId } = await seedRestrictedAgent();
  const d = db();
  // Restrict the whole workspace's agents to "assigned" — what makes this
  // agent a restricted viewer. Restored in finally; the suite's other actors
  // are admins, whom the setting never restricts.
  await d.workspace.update({
    where: { id: E2E_APP_WS_ID },
    data: { agentConversationVisibility: "assigned" },
  });

  const conversationId = await seedConversation();

  const subject = `Realtime assign ${Date.now()}`;
  const made = await adminPage.request.post("/api/tickets", {
    data: { conversationId, subject },
  });
  const { ticket } = (await made.json()) as { ticket: { id: string } };

  let agentPage: Page | null = null;
  try {
    agentPage = await loginAs(browser, AGENT_EMAIL, AGENT_PASSWORD);
    await agentPage.goto("/tickets", { timeout: 120_000, waitUntil: "domcontentloaded" });
    // The board is empty for a restricted agent with nothing assigned; wait for
    // the shell so the socket is connected before the admin acts.
    await expect(
      agentPage.getByRole("heading", { name: "Tickets", exact: true }).first(),
    ).toBeVisible({ timeout: 60_000 });
    await agentPage.waitForTimeout(2_000);
    await expect(agentPage.getByText(subject)).toHaveCount(0);

    // THE REPORTED BUG: admin assigns; the card must appear on the agent's
    // board with NO reload. Before the user-room co-targeting, this frame never
    // reached a restricted agent's socket.
    await adminPage.request.patch(`/api/tickets/${ticket.id}`, {
      data: { assignedUserId: agentId },
    });
    await expect(agentPage.getByText(subject)).toBeVisible({ timeout: 20_000 });
    // ...and the bell heard it too (badge on the rail's bell button).
    await expect(
      agentPage.getByRole("button", { name: /Notifications \(\d+ unread\)/ }),
    ).toBeVisible({ timeout: 20_000 });

    // A reply lands live on their board: card highlight + it stays visible.
    await adminPage.request.post(`/api/tickets/${ticket.id}/thread`, {
      multipart: { body: `answer for the agent ${Date.now()}` },
    });
    // The whole-card highlight (sky ring) appears without a reload.
    await expect(
      agentPage.locator("article", { hasText: subject }).first(),
    ).toHaveClass(/border-sky-500/, { timeout: 20_000 });
    // ...and exactly ONE toast ABOUT THE REPLY — the bell's. The board used to
    // toast too ("New reply on #N"), so one reply showed two toasts in two
    // wordings. Counted by content, not total: on this shared dev box the API
    // hot-reloads under the test and an unrelated "Couldn't load tickets"
    // error toast must not fail the single-reply-toast semantics.
    await agentPage.waitForTimeout(1_000);
    expect(
      await agentPage.locator("[data-sonner-toast]", { hasText: /repl/i }).count(),
    ).toBe(1);
    expect(
      await agentPage.locator("[data-sonner-toast]", { hasText: "New reply on" }).count(),
    ).toBe(0);

    // Opening the ticket clears EVERYTHING about it — pill, dot and bell — in
    // one visit (one read-state rule).
    await agentPage.getByRole("link", { name: subject }).click();
    await expect(
      agentPage.getByRole("heading", { name: "Thread", exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      agentPage.getByRole("button", { name: "Notifications", exact: true }),
    ).toBeVisible({ timeout: 20_000 });

    // Reassignment AWAY removes it live: the previous assignee's user room is
    // co-targeted via `alsoNotifyUserIds`, so their board drops the card.
    await agentPage.goto("/tickets", { timeout: 120_000, waitUntil: "domcontentloaded" });
    await expect(agentPage.getByText(subject)).toBeVisible({ timeout: 60_000 });
    await adminPage.request.patch(`/api/tickets/${ticket.id}`, {
      data: { assignedUserId: null },
    });
    await expect(agentPage.getByText(subject)).toHaveCount(0, { timeout: 20_000 });
  } finally {
    await d.workspace.update({
      where: { id: E2E_APP_WS_ID },
      data: { agentConversationVisibility: "team" },
    });
    await adminPage.request.delete(`/api/tickets/${ticket.id}`).catch(() => undefined);
    await agentPage?.context().close();
  }
});

test("the ACTOR gets no toast for their own reply", async ({ page }) => {
  test.setTimeout(240_000);
  const conversationId = await seedConversation();

  const subject = `No self toast ${Date.now()}`;
  const made = await page.request.post("/api/tickets", { data: { conversationId, subject } });
  const { ticket } = (await made.json()) as { ticket: { id: string } };

  try {
    await page.goto("/tickets", { timeout: 120_000, waitUntil: "domcontentloaded" });
    await expect(page.getByText(subject)).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(1_500);

    // Your own reply must raise no toast, no bell, no pill — self-notification
    // is what makes a bell something people mute.
    await page.request.post(`/api/tickets/${ticket.id}/thread`, {
      multipart: { body: `self reply ${Date.now()}` },
    });
    await page.waitForTimeout(4_000);
    expect(await page.locator("[data-sonner-toast]").count()).toBe(0);
  } finally {
    await page.request.delete(`/api/tickets/${ticket.id}`).catch(() => undefined);
  }
});
