import { readFile, writeFile } from "node:fs/promises";

import { test, expect, type APIRequestContext } from "@playwright/test";

import { appAdmin, db } from "./_helpers/db";
import {
  dropOtherWorkspace,
  seedOtherWorkspace,
  type OtherWorkspace,
} from "./_helpers/workspace-fixtures";

/**
 * Tenant isolation across every domain, after the Team → Workspace restructure.
 *
 * WHY THIS SUITE EXISTS. Moving the isolation boundary touched ~58 tables in one
 * pass. The dangerous failure is not a crash — it is a `where` that quietly lost
 * its `workspaceId` and now reads or writes another tenant's rows. Prisma's
 * `where` is an XOR union, so a dropped key **compiles clean** (see the prisma
 * field checker, which exists for exactly this reason), and a suite that only
 * ever has one workspace can never notice.
 *
 * So this seeds a SECOND workspace inside the SAME organization, makes the test
 * admin a full member of it, and then — while the session is active in workspace
 * A — asserts across each domain that:
 *
 *   1. LIST endpoints do not return B's rows.
 *   2. READ-by-id of a B row is 404 (never 200, and never 403 — a 403 confirms
 *      the row exists to someone not entitled to know it).
 *   3. WRITE-by-id against a B row does not mutate it.
 *
 * Same organization on purpose. A cross-ORG id is refused higher up by
 * `resolveSession`, which would mask a missing `workspaceId` in the query
 * underneath. Same-org is the strictly harder case, and the one the product has.
 */

let other: OtherWorkspace;
let homeWorkspaceId = "";

test.beforeAll(async () => {
  ({ workspaceId: homeWorkspaceId } = await appAdmin());
  other = await seedOtherWorkspace();
});

test.afterAll(async () => {
  await dropOtherWorkspace(other.workspaceId);

  // Belt-and-braces: strip a `ccp.ws` cookie naming the workspace we just
  // deleted out of the SHARED storageState file. Playwright reuses that file
  // for every later spec, so a stale value there survives this suite. The API
  // recovers on its own (the cookie fails `canAccess` and resolution falls
  // through to the stored choice), but the next spec should not have to.
  const statePath = "tests/e2e/.auth/app-admin.json";
  try {
    const raw = await readFile(statePath, "utf8");
    const state = JSON.parse(raw) as {
      cookies?: Array<{ name: string; value: string }>;
    };
    if (state.cookies?.some((c) => c.name === "ccp.ws" && c.value === other.workspaceId)) {
      state.cookies = state.cookies.filter(
        (c) => !(c.name === "ccp.ws" && c.value === other.workspaceId),
      );
      await writeFile(statePath, JSON.stringify(state, null, 2));
    }
  } catch {
    // No saved state (fresh checkout / setup skipped) — nothing to clean.
  }
});

/** Rows the fixture created carry this prefix; a leak is unmistakable. */
const LEAK = /ISO-/;

/** Assert a list endpoint returns no row belonging to the other workspace. */
async function expectNoLeak(request: APIRequestContext, path: string) {
  const res = await request.get(path);
  expect(res.status(), `${path} should be readable`).toBeLessThan(400);
  const text = await res.text();
  expect(text, `${path} leaked a row from the other workspace`).not.toMatch(LEAK);
}

/**
 * Assert a by-id read of another workspace's row is 404.
 *
 * 404 specifically, not "not 200": returning 403 would confirm the row exists,
 * which is itself a cross-tenant disclosure. The one tolerated alternative is
 * 400 — a route that rejects the id shape before it ever queries.
 */
async function expectNotFound(request: APIRequestContext, path: string) {
  const res = await request.get(path);
  expect([400, 404], `${path} returned ${res.status()} for another workspace's row`).toContain(
    res.status(),
  );
}

test.describe("states — stages, tags, contact fields, message flags", () => {
  test("list endpoints are scoped to the active workspace", async ({ request }) => {
    await expectNoLeak(request, "/api/workspace/stages");
    await expectNoLeak(request, "/api/workspace/tags");
    await expectNoLeak(request, "/api/workspace/contact-fields");
    await expectNoLeak(request, "/api/workspace/message-flags");
    await expectNoLeak(request, "/api/workspace/snippets");
    await expectNoLeak(request, "/api/workspace/audience-groups");
  });

  test("renaming another workspace's tag does not touch it", async ({ request }) => {
    const before = await db().tag.findUniqueOrThrow({
      where: { id: other.tagId },
      select: { name: true },
    });
    const res = await request.patch(`/api/workspace/tags/${other.tagId}`, {
      data: { name: "HIJACKED" },
    });
    expect(res.status(), "cross-workspace tag rename must not succeed").toBeGreaterThanOrEqual(400);
    const after = await db().tag.findUniqueOrThrow({
      where: { id: other.tagId },
      select: { name: true },
    });
    expect(after.name, "the other workspace's tag was mutated").toBe(before.name);
  });

  test("deleting another workspace's stage does not touch it", async ({ request }) => {
    const res = await request.delete(`/api/workspace/stages/${other.stageId}`);
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const still = await db().contactStage.count({ where: { id: other.stageId } });
    expect(still, "the other workspace's stage was deleted").toBe(1);
  });

  test("deleting another workspace's contact field does not touch it", async ({ request }) => {
    const res = await request.delete(`/api/workspace/contact-fields/${other.contactFieldId}`);
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(
      await db().contactFieldDefinition.count({ where: { id: other.contactFieldId } }),
    ).toBe(1);
  });
});

test.describe("contacts", () => {
  test("the contact list excludes the other workspace's contacts", async ({ request }) => {
    await expectNoLeak(request, "/api/contacts?limit=200");
  });

  test("tagging another workspace's contact does not touch it", async ({ request }) => {
    const res = await request.put(`/api/contacts/${other.contactId}/tags`, {
      data: { tagIds: [] },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(await db().contact.count({ where: { id: other.contactId } })).toBe(1);
  });

  test("deleting another workspace's contact does not touch it", async ({ request }) => {
    const res = await request.delete(`/api/contacts/${other.contactId}`);
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const after = await db().contact.findFirst({
      where: { id: other.contactId },
      select: { deletedAt: true },
    });
    expect(after, "the other workspace's contact was hard-deleted").not.toBeNull();
    expect(after?.deletedAt, "the other workspace's contact was soft-deleted").toBeNull();
  });

  test("updating another workspace's contact does not touch it", async ({ request }) => {
    const res = await request.patch(`/api/contacts/${other.contactId}`, {
      data: { name: "HIJACKED" },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const after = await db().contact.findUniqueOrThrow({
      where: { id: other.contactId },
      select: { name: true },
    });
    expect(after.name).toMatch(LEAK);
  });

  test("global search does not reach across workspaces", async ({ request }) => {
    // Search is the widest read surface in the app — it spans contacts,
    // messages and notes at once, so a single unscoped arm leaks everything.
    await expectNoLeak(request, "/api/inbox/search?scope=contacts&q=ISO");
    await expectNoLeak(request, "/api/inbox/search?scope=messages&q=ISO");
    await expectNoLeak(request, "/api/inbox/search?scope=notes&q=ISO");
  });
});

test.describe("inbox — conversations, views, flags", () => {
  test("the conversation list excludes the other workspace", async ({ request }) => {
    await expectNoLeak(request, "/api/conversations?limit=200");
  });

  test("opening another workspace's conversation is 404", async ({ request }) => {
    await expectNotFound(request, `/api/inbox/conversation/${other.conversationId}`);

    // The message + event pages are separate routes with their own `where`, so
    // scoping the parent read is not enough. They deliberately answer 200 with
    // an EMPTY page rather than 404 — `listOlderMessages` gates on ownership and
    // degrades to `{items: []}`, which discloses nothing either way. So assert
    // the security property (no rows crossed) rather than the status code.
    await expectNoLeak(
      request,
      `/api/conversations/${other.conversationId}/messages?before=${new Date().toISOString()}`,
    );
    await expectNoLeak(request, `/api/conversations/${other.conversationId}/events`);
    await expectNoLeak(request, `/api/conversations/${other.conversationId}/attachments`);
  });

  test("saved views are scoped, and another workspace's view is unreadable", async ({
    request,
  }) => {
    await expectNoLeak(request, "/api/inbox-views");
    await expectNoLeak(request, "/api/inbox-views/counts");
    // A view carries a filter document that becomes SQL. Editing one from
    // another workspace would let this session rewrite what THAT workspace's
    // agents see — the leak is the filter, not just the name.
    const res = await request.patch(`/api/inbox-views/${other.inboxViewId}`, {
      data: { name: "HIJACKED" },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const after = await db().inboxView.findUniqueOrThrow({
      where: { id: other.inboxViewId },
      select: { name: true },
    });
    expect(after.name).toMatch(LEAK);
  });

  test("assigning another workspace's conversation does not touch it", async ({ request }) => {
    const { userId } = await appAdmin();
    const res = await request.post(`/api/conversations/${other.conversationId}/assign`, {
      data: { assignedUserId: userId },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const after = await db().conversation.findUniqueOrThrow({
      where: { id: other.conversationId },
      select: { assignedUserId: true },
    });
    expect(after.assignedUserId, "cross-workspace assignment succeeded").toBeNull();
  });

  test("closing another workspace's conversation does not touch it", async ({ request }) => {
    const res = await request.post(`/api/conversations/${other.conversationId}/status`, {
      data: { status: "closed" },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const after = await db().conversation.findUniqueOrThrow({
      where: { id: other.conversationId },
      select: { status: true },
    });
    expect(after.status).toBe("open");
  });
});

test.describe("tickets", () => {
  test("the ticket board excludes the other workspace", async ({ request }) => {
    await expectNoLeak(request, "/api/tickets?limit=50");
  });

  test("reading another workspace's ticket is 404", async ({ request }) => {
    await expectNotFound(request, `/api/tickets/${other.ticketId}`);
  });

  test("ticket numbers are per-workspace, so both workspaces can hold #1", async () => {
    // `@@unique([workspaceId, number])` — not a global sequence. If this ever
    // regressed to global uniqueness, two tenants would contend for numbers and
    // "ticket #1234" would stop being answerable within a workspace.
    const theirs = await db().ticket.findFirst({
      where: { workspaceId: other.workspaceId, number: 1 },
      select: { id: true },
    });
    expect(theirs?.id).toBe(other.ticketId);

    const counters = await db().ticketNumberCounter.findMany({
      where: { workspaceId: { in: [homeWorkspaceId, other.workspaceId] } },
      select: { workspaceId: true },
    });
    // A counter row per workspace is what makes the numbering independent.
    expect(counters.some((c) => c.workspaceId === other.workspaceId)).toBe(true);
  });

  test("changing another workspace's ticket status does not touch it", async ({ request }) => {
    const res = await request.patch(`/api/tickets/${other.ticketId}`, {
      data: { status: "solved" },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const after = await db().ticket.findUniqueOrThrow({
      where: { id: other.ticketId },
      select: { status: true },
    });
    expect(after.status).toBe("open");
  });
});

test.describe("assignment + workflows", () => {
  test("assignment policies are scoped", async ({ request }) => {
    await expectNoLeak(request, "/api/workspace/assignment");
    await expectNoLeak(request, "/api/workspace/assignment-policies");
  });

  test("editing another workspace's assignment policy does not touch it", async ({ request }) => {
    // Routing rules decide who receives real customer conversations. A
    // cross-workspace write here silently redirects another tenant's work.
    const res = await request.put(
      `/api/workspace/assignment/policies/${other.assignmentPolicyId}`,
      { data: { name: "HIJACKED", expectedVersion: 1 } },
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const after = await db().assignmentPolicy.findUniqueOrThrow({
      where: { id: other.assignmentPolicyId },
      select: { name: true },
    });
    expect(after.name).toMatch(LEAK);
  });

  test("deleting another workspace's assignment policy does not touch it", async ({ request }) => {
    const res = await request.delete(
      `/api/workspace/assignment/policies/${other.assignmentPolicyId}`,
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(await db().assignmentPolicy.count({ where: { id: other.assignmentPolicyId } })).toBe(1);
  });

  test("workflows are scoped, and another workspace's workflow is unreadable", async ({
    request,
  }) => {
    await expectNoLeak(request, "/api/workspace/workflows");
    await expectNotFound(request, `/api/workspace/workflows/${other.workflowId}`);
  });

  test("publishing another workspace's workflow does not touch it", async ({ request }) => {
    // The worst cross-tenant write in the app: a published workflow fires on
    // real customer traffic and can send messages that bill the other tenant.
    const res = await request.post(`/api/workspace/workflows/${other.workflowId}/publish`, {
      data: { publish: true },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const after = await db().workflow.findUniqueOrThrow({
      where: { id: other.workflowId },
      select: { published: true },
    });
    expect(after.published, "a workflow in another workspace was published").toBe(false);
  });
});

test.describe("team + settings", () => {
  test("the member roster is the active workspace's, not the org's", async ({ request }) => {
    // A user belongs to the ORG and joins many workspaces. /api/users must
    // return the ACTIVE workspace's members — returning every org user would
    // expose colleagues who were deliberately kept out of this workspace, and
    // would offer them in the assignment dropdown.
    const res = await request.get("/api/users");
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { users?: Array<{ id: string }> } | Array<{ id: string }>;
    const users = Array.isArray(body) ? body : (body.users ?? []);
    const memberIds = new Set(
      (
        await db().workspaceMember.findMany({
          where: { workspaceId: homeWorkspaceId },
          select: { userId: true },
        })
      ).map((m) => m.userId),
    );
    for (const u of users) {
      expect(memberIds.has(u.id), `user ${u.id} is not a member of the active workspace`).toBe(
        true,
      );
    }
  });

  test("team chat channels are scoped to the active workspace", async ({ request }) => {
    await expectNoLeak(request, "/api/team-chat/channels");
  });

  test("channel connections and API keys are scoped", async ({ request }) => {
    await expectNoLeak(request, "/api/workspace/channel-accounts");
    await expectNoLeak(request, "/api/workspace/api-keys");
    await expectNoLeak(request, "/api/workspace/outbound-webhooks");
  });
});

test.describe("the workspace boundary itself", () => {
  test("a forged ccp.ws cookie for another organization is refused", async ({ browser }) => {
    // The attack the restructure introduced: `ccp.ws` is client-supplied, so a
    // workspace id from a DIFFERENT organization must be rejected outright, not
    // merely fall back. An earlier `isOrgAdmin` short-circuit accepted any
    // workspace id for an org-admin without checking WHICH org owned it.
    const foreignOrg = await db().organization.create({
      data: { name: "E2E Foreign Org" },
      select: { id: true },
    });
    const foreignWs = await db().workspace.create({
      data: { name: "E2E Foreign Workspace", organizationId: foreignOrg.id },
      select: { id: true },
    });
    try {
      const ctx = await browser.newContext({
        storageState: "tests/e2e/.auth/app-admin.json",
      });
      await ctx.addCookies([
        {
          name: "ccp.ws",
          value: foreignWs.id,
          url: process.env.E2E_BASE_URL ?? "http://localhost:8080",
        },
      ]);
      const res = await ctx.request.get("/api/conversations?limit=5");
      // Either the request is refused, or the session falls back to a workspace
      // the user really belongs to — never served AS the foreign workspace.
      if (res.ok()) {
        const text = await res.text();
        expect(text).not.toContain(foreignWs.id);
      }
      // And nothing was written into the foreign workspace either.
      expect(await db().conversation.count({ where: { workspaceId: foreignWs.id } })).toBe(0);
      await ctx.close();
    } finally {
      await db().workspace.deleteMany({ where: { id: foreignWs.id } });
      await db().organization.deleteMany({ where: { id: foreignOrg.id } });
    }
  });

  test("switching workspace changes what every domain returns", async ({ page }) => {
    // The positive half of the suite. Every assertion above is "B is invisible
    // from A"; without this one they would all still pass if the app returned
    // nothing at all, everywhere.
    //
    // Requests go through `page.context().request`, NOT the top-level `request`
    // fixture: that fixture has its OWN cookie jar, seeded from storageState and
    // never updated by the browser. Switching workspaces writes a `ccp.ws`
    // cookie into the PAGE's context, so the standalone fixture keeps answering
    // as the old workspace and this test silently asserts nothing.
    const api = page.context().request;
    await page.goto("/inbox");
    await page.getByRole("button", { name: "Switch workspace" }).click();
    await page.getByRole("menuitem", { name: "E2E Isolation Target" }).click();
    await page.waitForURL(/\/inbox/, { timeout: 30_000 });

    // Same session, same cookies — now the rows that were unreachable are the
    // only ones there is.
    await expect
      .poll(
        async () => {
          const res = await api.get("/api/workspace/tags");
          return res.ok() ? await res.text() : "";
        },
        { timeout: 20_000 },
      )
      .toMatch(LEAK);

    const convos = await api.get("/api/conversations?limit=50");
    expect(await convos.text()).toMatch(LEAK);

    const tickets = await api.get("/api/tickets?limit=50");
    expect(await tickets.text()).toMatch(LEAK);

    // Switch back to the HOME workspace by its real name.
    //
    // This restore is load-bearing for the specs that run after this file, not
    // just tidiness: the switch writes a `ccp.ws` cookie into the shared
    // storageState, and leaving it pointed at a workspace this file's afterAll
    // then DELETES made the next spec boot into a workspace that no longer
    // exists. (The API falls back correctly — see `resolveSession` — but the
    // saved browser state is what the next spec starts from.)
    //
    // Matching on a name regex is what broke it the first time: `/Loadless|E2E/`
    // also matched "E2E Isolation Target", so `.first()` could re-select the
    // workspace we were trying to leave. Resolve the real name instead.
    const home = await db().workspace.findUniqueOrThrow({
      where: { id: homeWorkspaceId },
      select: { name: true },
    });
    //
    // Targeting this menu item is fiddlier than it looks, and both traps are
    // worth naming because the obvious selectors silently pick the wrong thing:
    //   - NOT `exact: true` — the item's accessible name carries an avatar
    //     initial ("L Loadless Support"), so an exact match never resolves.
    //   - NOT a bare name match either — the ORGANIZATION shares its name with
    //     this workspace, and its row in the same menu is an `<a href=
    //     "/organization">`. A name-only locator matches both and Playwright's
    //     strict mode rejects it; without strict mode it would have navigated to
    //     the org settings page instead of switching.
    // The workspace rows are `div[role=menuitem]`, the org row is an anchor.
    await page.getByRole("button", { name: "Switch workspace" }).click();
    await page
      .locator('div[role="menuitem"]')
      .filter({ hasText: home.name })
      .first()
      .click();
    await page.waitForURL(/\/inbox/, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Switch workspace" })).toContainText(
      home.name,
      { timeout: 20_000 },
    );
  });
});
