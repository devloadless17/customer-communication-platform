import { test, expect } from "@playwright/test";

import { appAdmin, createTestWorkspace, createTestUser, db } from "../_helpers/db";
import { superadminTeam } from "../_helpers/platform";

/**
 * OPERATOR MODE, end to end.
 *
 * The platform operator can enter ANY workspace on the box with admin rights,
 * holding no `WorkspaceMember` row — and their PASSIVE VIEWING must leave no
 * trace the tenant could observe. Two halves, and the second is the one that
 * needs a test: "the operator can read the tenant's inbox" fails loudly the
 * moment it breaks, while "the operator's viewing silently cleared the team's
 * unread badge" would ship unnoticed and be invisible in the UI afterwards.
 *
 * Uses the SUPERADMIN storageState (customer-app specs use app-admin), like
 * every other spec in this directory.
 *
 * All fixtures live in an `e2e-` org so `wipeTestData` and the isolation canary
 * can tell them from a real tenant. The operator's own seeded workspace is
 * READ-ONLY here, per `_helpers/platform.ts`.
 */
test.use({ storageState: "tests/e2e/.auth/superadmin.json" });

let tenantOrgId = "";
let tenantWorkspaceId = "";
let tenantAgentId = "";
let operatorUserId = "";
let conversationId = "";
// The control's thread, in the app-admin's OWN workspace — see its test.
let controlConversationId = "";
let controlContactId = "";

test.beforeAll(async () => {
  ({ userId: operatorUserId } = await superadminTeam());

  // A CUSTOMER organization — a different org from the operator's anchor, which
  // is the whole point: the org-admin escape is org-scoped, only the operator
  // branch crosses this line.
  ({ organizationId: tenantOrgId, workspaceId: tenantWorkspaceId } =
    await createTestWorkspace({ name: "E2E Operator Tenant" }));

  // A real member of that workspace, so the "who is in this workspace" query
  // has a truthful answer to compare the operator against.
  ({ id: tenantAgentId } = await createTestUser({
    workspaceId: tenantWorkspaceId,
    name: "Tenant Agent",
    email: `e2e-tenant-agent-${Date.now()}@loadless.test`,
    role: "admin",
  }));

  const contact = await db().contact.create({
    data: {
      workspaceId: tenantWorkspaceId,
      identityChannel: "whatsapp",
      phoneNumber: `1555${Date.now().toString().slice(-7)}`,
      name: "Operator Test Customer",
    },
    select: { id: true },
  });

  // unreadCount > 0 is the fixture the stealth assertion turns on.
  const conversation = await db().conversation.create({
    data: {
      workspaceId: tenantWorkspaceId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      unreadCount: 3,
      lastMessageAt: new Date(),
      lastMessagePreview: "Hello?",
    },
    select: { id: true },
  });
  conversationId = conversation.id;

  // The control's fixture, in the app-admin's own `e2e-app-ws` — a workspace
  // the app-admin storageState is a real member of, so the same route can be
  // exercised by a non-operator.
  const { workspaceId: appWorkspaceId } = await appAdmin();
  const controlContact = await db().contact.create({
    data: {
      workspaceId: appWorkspaceId,
      identityChannel: "whatsapp",
      phoneNumber: `1556${Date.now().toString().slice(-7)}`,
      name: "Operator Control Customer",
    },
    select: { id: true },
  });
  controlContactId = controlContact.id;
  const controlConversation = await db().conversation.create({
    data: {
      workspaceId: appWorkspaceId,
      contactId: controlContact.id,
      channel: "whatsapp",
      status: "open",
      unreadCount: 3,
      lastMessageAt: new Date(),
      lastMessagePreview: "Control",
    },
    select: { id: true },
  });
  controlConversationId = controlConversation.id;
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
  // Deleting the ORG cascades to its workspace, its rows, its users AND its
  // OperatorAccess log (the row's only FK).
  await db()
    .organization.delete({ where: { id: tenantOrgId } })
    .catch(() => undefined);
  // The control's rows live in the SHARED `e2e-app-ws`, which this spec does not
  // own — self-clean them rather than leaving a stray unread thread for an
  // honest downstream spec to trip over.
  if (controlConversationId) {
    await db()
      .conversation.delete({ where: { id: controlConversationId } })
      .catch(() => undefined);
  }
  if (controlContactId) {
    await db()
      .contact.delete({ where: { id: controlContactId } })
      .catch(() => undefined);
  }
});

test.describe("entering a tenant workspace", () => {
  test("a foreign ccp.ws cookie alone does NOT serve the tenant's inbox to a non-operator", async ({
    browser,
  }) => {
    // The org-admin half of the access rule, pinned from this side too. This is
    // the branch that was the real vulnerability, and splitting the rule in two
    // is exactly the change that could re-merge them by accident. The
    // app-admin (an ordinary customer org admin) must NOT reach the tenant.
    const ctx = await browser.newContext({
      storageState: "tests/e2e/.auth/app-admin.json",
    });
    await ctx.addCookies([
      {
        name: "ccp.ws",
        value: tenantWorkspaceId,
        url: process.env.E2E_BASE_URL ?? "http://localhost:8080",
      },
    ]);
    const res = await ctx.request.get("/api/conversations?limit=5");
    if (res.ok()) {
      // Falling back to their own workspace is fine; being SERVED as the
      // tenant is not.
      expect(await res.text()).not.toContain(conversationId);
    }
    await ctx.close();
  });

  test("the operator enters, is recorded, and reads the tenant's inbox", async ({
    page,
  }) => {
    const before = await db().operatorAccess.count({
      where: { organizationId: tenantOrgId },
    });

    const res = await page.request.post("/api/admin/operator-access", {
      data: { workspaceId: tenantWorkspaceId },
    });
    expect(res.ok()).toBe(true);

    // The log is written, and it names the workspace that was entered.
    const entries = await db().operatorAccess.findMany({
      where: { organizationId: tenantOrgId },
      select: { userId: true, enteredWorkspaceId: true },
    });
    expect(entries.length).toBe(before + 1);
    expect(entries.some((e) => e.userId === operatorUserId)).toBe(true);
    expect(entries.some((e) => e.enteredWorkspaceId === tenantWorkspaceId)).toBe(true);

    // And the session now resolves INTO the tenant.
    const convs = await page.request.get("/api/conversations?limit=20");
    expect(convs.ok()).toBe(true);
    expect(await convs.text()).toContain(conversationId);
  });

  test("the operator never becomes a member of the workspace", async ({ page }) => {
    await page.request.post("/api/admin/operator-access", {
      data: { workspaceId: tenantWorkspaceId },
    });

    // No membership row — this is what keeps them out of assignment pools,
    // availability, seat counts and every people-picker.
    expect(
      await db().workspaceMember.count({
        where: { userId: operatorUserId, workspaceId: tenantWorkspaceId },
      }),
    ).toBe(0);

    // And the workspace's own roster does not list them.
    const users = await page.request.get("/api/users");
    expect(users.ok()).toBe(true);
    const body = await users.text();
    expect(body).toContain(tenantAgentId);
    expect(body).not.toContain(operatorUserId);
  });
});

test.describe("stealth: passive viewing leaves no trace", () => {
  test("operator mark-read does NOT clear the team-wide unread badge", async ({
    page,
  }) => {
    await db().conversation.update({
      where: { id: conversationId },
      data: { unreadCount: 3 },
    });
    await page.request.post("/api/admin/operator-access", {
      data: { workspaceId: tenantWorkspaceId },
    });

    // The route answers ok — the client fires it on every visible thread mount,
    // so a 403 would surface as a broken inbox rather than as stealth.
    const read = await page.request.post(`/api/conversations/${conversationId}/read`);
    expect(read.ok()).toBe(true);

    // ...and the counter is untouched. Unread is TEAM-WIDE (§10) with no
    // per-agent read state, so clearing it here would silently mark as read
    // work nobody on the tenant's team has seen.
    const after = await db().conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { unreadCount: true },
    });
    expect(after.unreadCount).toBe(3);
  });

  test("the SAME route still clears unread for an ordinary member (the control)", async ({
    browser,
  }) => {
    // Without this the assertion above would pass just as happily against a
    // route that never worked for anyone. It proves the gate is about WHO is
    // asking, not about the endpoint being dead.
    //
    // Driven as a real HTTP call by a real member, in the app-admin's OWN
    // workspace — the tenant's agent is a bare fixture with no credential, and
    // minting a login for one would test the login flow rather than this. A
    // different workspace is fine and arguably better: the claim under test is
    // "this endpoint clears unread for a non-operator", which is exactly what a
    // second tenant demonstrates.
    await db().conversation.update({
      where: { id: controlConversationId },
      data: { unreadCount: 3 },
    });

    const ctx = await browser.newContext({
      storageState: "tests/e2e/.auth/app-admin.json",
    });
    const res = await ctx.request.post(`/api/conversations/${controlConversationId}/read`);
    expect(res.ok()).toBe(true);
    await ctx.close();

    const after = await db().conversation.findUniqueOrThrow({
      where: { id: controlConversationId },
      select: { unreadCount: true },
    });
    expect(after.unreadCount).toBe(0);
  });

  test("operator typing is not relayed to the customer", async ({ page }) => {
    await page.request.post("/api/admin/operator-access", {
      data: { workspaceId: tenantWorkspaceId },
    });
    const res = await page.request.post(`/api/conversations/${conversationId}/typing`, {
      data: { active: true },
    });
    expect(res.ok()).toBe(true);
    // The gate reports itself rather than silently succeeding, so a regression
    // shows up here instead of as a "typing…" bubble on a real customer's phone.
    expect(await res.json()).toMatchObject({ skipped: "operator_mode" });
  });
});
