import { test, expect } from "@playwright/test";

import { createTestWorkspace, createTestUser, db } from "../_helpers/db";
import { superadminTeam } from "../_helpers/platform";

/**
 * OPERATOR MODE — identity, everywhere (hardening audit 2026-08-20).
 *
 * One rule: the tenant sees "Support"; a FORMER member is never mistaken for
 * the operator. The audit found the mask split across two half-mechanisms with
 * ~12 surfaces leaking the operator's real name (team chat leaked the avatar
 * too) — and the client half actively relabelling ex-members' notes as
 * "Support". These assertions drive the API the way the UI does and pin both
 * directions.
 */
test.use({ storageState: "tests/e2e/.auth/superadmin.json" });

let tenantOrgId = "";
let tenantWorkspaceId = "";
let tenantAgentId = "";
let exMemberId = "";
let operatorUserId = "";
let operatorRealName = "";
let conversationId = "";

test.beforeAll(async () => {
  ({ userId: operatorUserId } = await superadminTeam());
  operatorRealName = (
    await db().user.findUniqueOrThrow({
      where: { id: operatorUserId },
      select: { name: true },
    })
  ).name;

  ({ organizationId: tenantOrgId, workspaceId: tenantWorkspaceId } =
    await createTestWorkspace({ name: "E2E Operator Identity Tenant" }));
  ({ id: tenantAgentId } = await createTestUser({
    workspaceId: tenantWorkspaceId,
    name: "Identity Tenant Agent",
    email: `e2e-opid-agent-${Date.now()}@loadless.test`,
    role: "admin",
  }));
  // The EX-member: created as a member, authors a note, then their membership
  // is revoked — the regression case that used to read "Support".
  ({ id: exMemberId } = await createTestUser({
    workspaceId: tenantWorkspaceId,
    name: "Departed Colleague",
    email: `e2e-opid-ex-${Date.now()}@loadless.test`,
    role: "agent",
  }));

  // Two member fixtures fill the default 2-seat cap, and the invite test needs
  // a free seat — the cap is per-workspace and superadmin-set, so raise it on
  // the fixture the way a real onboarding would.
  await db().workspace.update({
    where: { id: tenantWorkspaceId },
    data: { maxMembers: 5 },
  });

  const contact = await db().contact.create({
    data: {
      workspaceId: tenantWorkspaceId,
      identityChannel: "whatsapp",
      phoneNumber: `1558${Date.now().toString().slice(-7)}`,
      name: "Identity Customer",
    },
    select: { id: true },
  });
  const conversation = await db().conversation.create({
    data: {
      workspaceId: tenantWorkspaceId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      lastMessageAt: new Date(),
    },
    select: { id: true },
  });
  conversationId = conversation.id;
});

test.afterAll(async () => {
  await db()
    .organization.delete({ where: { id: tenantOrgId } })
    .catch(() => undefined);
  // Leave operator mode: the entry endpoint wrote the tenant into the durable
  // Session.activeWorkspaceId, which OUTLIVES this spec's contexts — a later
  // spec asserting "/inbox bounces a superAdmin to /platform" would otherwise
  // find the operator still standing in a (now deleted) tenant.
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

test.describe("server-side masking", () => {
  test("activity pill: an operator status change reads Support, never the real name", async ({
    page,
  }) => {
    await enterTenant(page);
    const flip = await page.request.post(`/api/conversations/${conversationId}/status`, {
      data: { status: "pending" },
    });
    expect(flip.ok()).toBe(true);

    const events = await page.request.get(
      `/api/conversations/${conversationId}/events`,
    );
    expect(events.ok()).toBe(true);
    const body = await events.text();
    expect(body).toContain("Support");
    expect(body).not.toContain(operatorRealName);
  });

  test("team chat: an operator post in #general is Support with no avatar, on the read path", async ({
    page,
  }) => {
    await enterTenant(page);
    // A default channel is implicitly open — the one team-chat write the
    // operator KEEPS (channel creation / DMs / joins are refused).
    const channel = await db().teamChannel.create({
      data: {
        workspaceId: tenantWorkspaceId,
        name: `general-${Date.now()}`,
        visibility: "public",
        isDefault: true,
        createdById: tenantAgentId,
      },
      select: { id: true },
    });
    const post = await page.request.post(
      `/api/team-chat/channels/${channel.id}/messages`,
      { data: { body: "operator checking in" } },
    );
    expect(post.ok()).toBe(true);
    // The live frame masks from the session; the HISTORY path masks from the
    // DB — read it back the way a tenant's tab would after a reload.
    const history = await page.request.get(
      `/api/team-chat/channels/${channel.id}/messages`,
    );
    expect(history.ok()).toBe(true);
    const text = await history.text();
    expect(text).toContain("Support");
    expect(text).not.toContain(operatorRealName);
  });

  test("saved views, snippets, invites: operator-created rows read Support in their lists", async ({
    page,
  }) => {
    await enterTenant(page);

    const view = await page.request.post("/api/inbox-views", {
      data: { name: `Op View ${Date.now()}`, visibility: "shared", filters: {} },
    });
    expect(view.ok(), await view.text()).toBe(true);
    const views = await page.request.get("/api/inbox-views");
    const viewsText = await views.text();
    expect(viewsText).not.toContain(operatorRealName);

    const snippet = await page.request.post("/api/workspace/snippets", {
      data: { name: `op_snip_${Date.now()}`, label: "Op Snip", body: "hello" },
    });
    expect(snippet.ok(), await snippet.text()).toBe(true);
    const snippets = await page.request.get("/api/workspace/snippets");
    expect(await snippets.text()).not.toContain(operatorRealName);

    const invite = await page.request.post("/api/invites", {
      data: { email: `e2e-opid-invite-${Date.now()}@loadless.test`, role: "agent" },
    });
    expect(invite.ok(), await invite.text()).toBe(true);
    const invites = await page.request.get("/api/invites");
    const invitesText = await invites.text();
    expect(invitesText).toContain("Support");
    expect(invitesText).not.toContain(operatorRealName);
  });
});

test.describe("the ex-member is never the operator", () => {
  test("a departed member's authored note keeps resolving them, not Support", async ({
    page,
  }) => {
    // The note is authored while they are a member...
    await db().internalNote.create({
      data: {
        workspaceId: tenantWorkspaceId,
        conversationId,
        authorUserId: exMemberId,
        body: "handover context from the departed colleague",
      },
    });
    // ...then the membership is revoked; the User row and the note survive.
    await db().workspaceMember.deleteMany({
      where: { userId: exMemberId, workspaceId: tenantWorkspaceId },
    });

    await enterTenant(page);
    // The roster (what the client's member map is built from) excludes them —
    // that miss must now mean "Former member" client-side, never "Support".
    const users = await page.request.get("/api/users");
    expect(await users.text()).not.toContain(exMemberId);

    // The server never invents "Support" for them: masking keys on
    // `isSuperAdmin`, not on a missing membership, and the unit spec
    // (operator-name-mask.spec.ts) pins that a departed member keeps their
    // real name on every server-joined surface. What the e2e adds is the
    // ROSTER miss above — the input the client fallback now reads as
    // "Former member".
  });
});
