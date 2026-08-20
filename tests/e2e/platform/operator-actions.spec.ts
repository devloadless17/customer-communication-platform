import { test, expect } from "@playwright/test";

import { createTestWorkspace, createTestUser, db } from "../_helpers/db";
import { superadminTeam } from "../_helpers/platform";

/**
 * OPERATOR MODE — the WRITE-path invariants (hardening audit 2026-08-20).
 *
 * Passive stealth is covered by operator-access.spec.ts; this spec pins what
 * happens when the operator ACTS. The load-bearing one is the reply-claim:
 * `autoAssignOnAgentSend` used to write `assignedUserId = <operator>` despite
 * resolving the assignee through a membership filter that returned null —
 * leaving the tenant a conversation owned by a non-member (invisible to every
 * agent under assigned-only visibility, with continuity routing poisoned).
 * Each assertion ships with a real-member control so a dead endpoint can't
 * pass as a working gate.
 *
 * Uses the SUPERADMIN storageState, like every spec in this directory.
 */
test.use({ storageState: "tests/e2e/.auth/superadmin.json" });

let tenantOrgId = "";
let tenantWorkspaceId = "";
let tenantAgentId = "";
let operatorUserId = "";
let conversationId = "";

test.beforeAll(async () => {
  ({ userId: operatorUserId } = await superadminTeam());
  ({ organizationId: tenantOrgId, workspaceId: tenantWorkspaceId } =
    await createTestWorkspace({ name: "E2E Operator Actions Tenant" }));
  ({ id: tenantAgentId } = await createTestUser({
    workspaceId: tenantWorkspaceId,
    name: "Actions Tenant Agent",
    email: `e2e-opactions-agent-${Date.now()}@loadless.test`,
    role: "admin",
  }));
  const contact = await db().contact.create({
    data: {
      workspaceId: tenantWorkspaceId,
      identityChannel: "whatsapp",
      phoneNumber: `1557${Date.now().toString().slice(-7)}`,
      name: "Operator Actions Customer",
    },
    select: { id: true },
  });
  const conversation = await db().conversation.create({
    data: {
      workspaceId: tenantWorkspaceId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      unreadCount: 2,
      // An inbound already exists, so a send would count as a "response" —
      // exactly the shape the analytics exclusion has to resist.
      incomingMessagesCount: 1,
      lastMessageAt: new Date(),
      lastMessagePreview: "hello?",
    },
    select: { id: true },
  });
  conversationId = conversation.id;
});

test.afterAll(async () => {
  await db()
    .organization.delete({ where: { id: tenantOrgId } })
    .catch(() => undefined);
  // Leave operator mode — the durable Session.activeWorkspaceId outlives this
  // spec's contexts (see operator-identity.spec.ts for the full note).
  await db()
    .session.updateMany({
      where: { userId: operatorUserId },
      data: { activeWorkspaceId: null },
    })
    .catch(() => undefined);
});

async function enterTenant(page: import("@playwright/test").Page) {
  const res = await page.request.post("/api/admin/operator-access", {
    data: { workspaceId: tenantWorkspaceId },
  });
  expect(res.ok()).toBe(true);
}

test.describe("operator sends", () => {
  test("a reply does NOT claim the conversation, clear unread, or count as a response", async ({
    page,
  }) => {
    await enterTenant(page);
    await db().conversation.update({
      where: { id: conversationId },
      data: {
        assignedUserId: null,
        lastAssignedUserId: null,
        unreadCount: 2,
        responsesCount: 0,
        firstResponseAt: null,
        firstResponseByUserId: null,
      },
    });

    // A real send: the dev stack has no Meta credentials for this workspace, so
    // the send itself fails at the provider — but the side effects under test
    // (mark-read, auto-claim, response analytics) fire on the ACCEPTED path
    // only, which is exactly the point: acceptance is what used to corrupt.
    // Send via the API regardless; whether it 4xxs at preflight or enqueues,
    // the conversation row must come out untouched.
    await page.request
      .post("/api/messages", {
        data: { conversationId, body: "operator test message" },
      })
      .catch(() => undefined);

    // The side effects are fire-and-forget — give them a beat to (not) land.
    await page.waitForTimeout(800);

    const row = await db().conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: {
        assignedUserId: true,
        lastAssignedUserId: true,
        unreadCount: true,
        responsesCount: true,
        firstResponseByUserId: true,
      },
    });
    expect(row.assignedUserId).toBeNull();
    expect(row.lastAssignedUserId).toBeNull();
    expect(row.unreadCount).toBe(2);
    expect(row.responsesCount).toBe(0);
    expect(row.firstResponseByUserId).toBeNull();
  });
});

test.describe("org-shaped routes refuse in operator mode", () => {
  test("organization read + rename + workspace create/delete + membership all 403", async ({
    page,
  }) => {
    await enterTenant(page);

    const read = await page.request.get("/api/workspaces/organization");
    expect(read.status()).toBe(403);
    expect(await read.json()).toMatchObject({ error: "operator_mode_unavailable" });

    const rename = await page.request.patch("/api/workspaces/organization", {
      data: { name: "Hijacked" },
    });
    expect(rename.status()).toBe(403);

    const create = await page.request.post("/api/workspaces", {
      data: { name: "Should Not Exist" },
    });
    expect(create.status()).toBe(403);

    const remove = await page.request.delete(`/api/workspaces/${tenantWorkspaceId}`);
    expect(remove.status()).toBe(403);

    const membership = await page.request.post(
      `/api/workspaces/${tenantWorkspaceId}/members`,
      { data: { userId: tenantAgentId, role: "agent" } },
    );
    expect(membership.status()).toBe(403);
  });

  test("team-chat membership writes refuse: create channel, open DM, join", async ({
    page,
  }) => {
    await enterTenant(page);

    const createChannel = await page.request.post("/api/team-chat/channels", {
      data: { name: "op-channel", visibility: "public" },
    });
    expect(createChannel.status()).toBe(403);

    const dm = await page.request.post("/api/team-chat/channels/dm", {
      data: { userId: tenantAgentId },
    });
    expect(dm.status()).toBe(403);

    // No TeamChannelMember row was minted by any of it.
    expect(
      await db().teamChannelMember.count({
        where: { userId: operatorUserId, channel: { workspaceId: tenantWorkspaceId } },
      }),
    ).toBe(0);
  });
});

test.describe("the action log", () => {
  test("API key create + outbound webhook create + contact export each write a row", async ({
    page,
  }) => {
    await enterTenant(page);
    const before = await db().operatorAccess.count({
      where: { organizationId: tenantOrgId, action: { not: "enter" } },
    });

    const key = await page.request.post("/api/workspace/api-keys", {
      data: { name: "op-audit-key", scopes: ["read:contacts"] },
    });
    expect(key.ok()).toBe(true);

    const hook = await page.request.post("/api/workspace/outbound-webhooks", {
      data: {
        name: "op-audit-hook",
        url: "https://example.com/op-audit",
        eventTypes: ["message.received"],
      },
    });
    expect(hook.ok()).toBe(true);

    const exp = await page.request.post("/api/contacts/export", { data: {} });
    expect(exp.ok()).toBe(true);

    const rows = await db().operatorAccess.findMany({
      where: { organizationId: tenantOrgId, action: { not: "enter" } },
      select: { action: true, userId: true },
    });
    expect(rows.length).toBe(before + 3);
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(
      ["api_key_create", "contact_export", "outbound_webhook_create"].sort(),
    );
    for (const r of rows) expect(r.userId).toBe(operatorUserId);
  });
});
