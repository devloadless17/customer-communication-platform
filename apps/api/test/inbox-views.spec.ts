/**
 * Saved inbox views.
 *
 * What is worth proving here is not CRUD — it is the four places a saved view
 * can go quietly wrong:
 *
 *   1. VISIBILITY IS A READ BOUNDARY. A personal view is another agent's
 *      private working set. It must not appear in their list, and an id must
 *      404 rather than 403 (a 403 confirms it exists).
 *   2. THE FILTER DOCUMENT BECOMES SQL, and it must compose with — never
 *      clobber — the agent-visibility restriction. This is the bug class that
 *      has now shipped twice in this codebase: object spread is last-wins, so
 *      an `assignedUserId: null` view merged next to a restriction of
 *      `assignedUserId: <agent>` silently DELETES the restriction.
 *   3. `tagMatch: "all"` must be an AND, not an OR. One nested `some` with an
 *      `in` list reads as "all" and behaves as "any" — silent wrong results.
 *   4. DANGLING IDS WIDEN, they don't empty. Deleting one tag of five must not
 *      blank a view, which reads as "the inbox is broken".
 *
 *   pnpm --filter @ccp/api exec vitest run test/inbox-views.spec.ts
 */
import { existsSync } from "node:fs";

import { createTestPrismaClient } from "./_prisma";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  InboxViewsService,
  type InboxViewActor,
} from "@/inbox-views/inbox-views.service";
import { inboxViewWhereClauses } from "@/lib/inbox-views/where";
import { InboxViewCountsService } from "@/inbox-views/inbox-view-counts.service";
import { listConversations } from "@/lib/queries/conversations";
import { setSharedDb } from "@/lib/db";
import {
  inboxViewIsViewerScoped,
  matchesInboxViewFilters,
  summarizeInboxViewFilters,
  type InboxViewFilters,
} from "@ccp/shared/inbox-views/types";
import type { DbService } from "@/db/db.service";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
const service = new InboxViewsService(
  prisma as unknown as DbService,
  // Shared-view mutations publish a team.catalog_changed tick; the spec
  // exercises persistence + visibility, not fanout.
  { publish: async () => {} } as unknown as ConstructorParameters<typeof InboxViewsService>[1],
);

const S = `iv${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let otherWorkspaceId = "";
let aliceId = "";
let bobId = "";
let tagAId = "";
let tagBId = "";
let stageId = "";
let fieldKey = "";
let optRedId = "";
let optBlueId = "";

/** An actor that may manage shared views. */
const admin = (userId: string, ws = workspaceId): InboxViewActor => ({
  workspaceId: ws,
  userId,
  canManageShared: true,
});

/** An actor that may only save personal views. */
const agent = (userId: string): InboxViewActor => ({
  workspaceId,
  userId,
  canManageShared: false,
});

beforeAll(async () => {
  // `listConversations` is a framework-agnostic lib helper that reads the
  // shared pool DbService normally populates at Nest boot. There is no Nest
  // here, so point it at this spec's client — the same single-pool contract,
  // just established by hand.
  setSharedDb(prisma as unknown as Parameters<typeof setSharedDb>[0]);

  orgId = (
    await prisma.organization.create({
      data: { name: `IV Org ${S}`, status: "active", maxWorkspaces: 100 },
    })
  ).id;
  const mkUser = async (name: string) =>
    (
      await prisma.user.create({
        data: {
          organizationId: orgId,
          orgRole: "member",
          name,
          email: `${name.toLowerCase()}-${S}@example.test`,
        },
        select: { id: true },
      })
    ).id;
  aliceId = await mkUser("Alice");
  bobId = await mkUser("Bob");

  workspaceId = (
    await prisma.workspace.create({ data: { name: `IV ws ${S}`, organizationId: orgId } })
  ).id;
  otherWorkspaceId = (
    await prisma.workspace.create({ data: { name: `IV other ${S}`, organizationId: orgId } })
  ).id;
  for (const userId of [aliceId, bobId]) {
    await prisma.workspaceMember.create({
      data: { userId, workspaceId, role: "agent" },
    });
  }

  tagAId = (await prisma.tag.create({ data: { workspaceId, name: `vip-${S}`, color: "rose" } })).id;
  tagBId = (await prisma.tag.create({ data: { workspaceId, name: `eu-${S}`, color: "sky" } })).id;
  stageId = (
    await prisma.contactStage.create({
      data: { workspaceId, name: `Lead ${S}`, color: "amber", position: 0 },
    })
  ).id;

  // A select-type dimension for the `fields` criteria tests.
  fieldKey = `src_${S}`;
  const fieldDef = await prisma.contactFieldDefinition.create({
    data: { workspaceId, key: fieldKey, label: `Src ${S}`, type: "select" },
  });
  optRedId = (
    await prisma.contactFieldOption.create({
      data: { workspaceId, fieldId: fieldDef.id, name: `Red ${S}`, color: "rose", position: 0 },
    })
  ).id;
  optBlueId = (
    await prisma.contactFieldOption.create({
      data: { workspaceId, fieldId: fieldDef.id, name: `Blue ${S}`, color: "sky", position: 1 },
    })
  ).id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// 1. Visibility is a read boundary
// ---------------------------------------------------------------------------

describe("visibility", () => {
  it("keeps a personal view out of a teammate's list, and 404s the id", async () => {
    const mine = await service.create(agent(aliceId), {
      name: `Alice private ${S}`,
      filters: { statuses: ["open"] },
    });

    const bobsList = await service.list(agent(bobId));
    expect(bobsList.map((v) => v.id)).not.toContain(mine.id);

    // 404, NOT 403 — a 403 would confirm the view exists.
    await expect(service.get(agent(bobId), mine.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("shows a shared view to everyone, but only a manager may edit it", async () => {
    const shared = await service.create(admin(aliceId), {
      name: `Team escalations ${S}`,
      visibility: "shared",
      filters: { hasOpenFlags: true },
    });

    const asAgent = (await service.list(agent(bobId))).find((v) => v.id === shared.id);
    expect(asAgent).toBeDefined();
    // The flag the UI reads to decide whether to draw an edit button.
    expect(asAgent?.isEditable).toBe(false);

    await expect(
      service.update(agent(bobId), shared.id, { name: "Hijacked" }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const asAdmin = (await service.list(admin(bobId))).find((v) => v.id === shared.id);
    expect(asAdmin?.isEditable).toBe(true);
  });

  it("refuses to create a shared view without the capability", async () => {
    await expect(
      service.create(agent(aliceId), {
        name: `Nope ${S}`,
        visibility: "shared",
        filters: {},
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("does not leak a view across workspaces", async () => {
    const here = await service.create(admin(aliceId), {
      name: `Here ${S}`,
      visibility: "shared",
      filters: {},
    });
    await expect(
      service.get(admin(aliceId, otherWorkspaceId), here.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("gives an API-key actor SHARED views only — never an orphaned personal one", async () => {
    // A personal view whose author is then deleted has `createdById = NULL`.
    // A null-user actor passed straight into the where would match it.
    const orphan = await service.create(agent(bobId), {
      name: `Orphan ${S}`,
      filters: {},
    });
    await prisma.inboxView.update({
      where: { id: orphan.id },
      data: { createdById: null },
    });

    const key: InboxViewActor = { workspaceId, userId: null, canManageShared: true };
    const visible = await service.list(key);
    expect(visible.map((v) => v.id)).not.toContain(orphan.id);
    await expect(service.get(key, orphan.id)).rejects.toBeInstanceOf(NotFoundException);

    // …and it cannot claim ownership of one either.
    await expect(
      service.create(key, { name: `Key personal ${S}`, visibility: "personal", filters: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("re-owns a SHARED view to whoever takes it private", async () => {
    // Demoting without re-owning leaves `createdById` pointing at the original
    // author — or at NULL if they've been deleted — and a personal view whose
    // owner isn't you is invisible to everyone, including the person who just
    // made it. "Take this private" has to mean private TO ME.
    const shared = await service.create(admin(aliceId), {
      name: `Demote me ${S}`,
      visibility: "shared",
      filters: {},
    });

    await service.update(admin(bobId), shared.id, { visibility: "personal" });

    // Bob can see it…
    expect((await service.list(admin(bobId))).map((v) => v.id)).toContain(shared.id);
    // …and Alice, who created it, no longer can.
    expect((await service.list(admin(aliceId))).map((v) => v.id)).not.toContain(shared.id);
  });
});

// ---------------------------------------------------------------------------
// 2. Name uniqueness — the PARTIAL indexes
// ---------------------------------------------------------------------------

describe("name uniqueness", () => {
  it("is per-person for personal views, and case-insensitive", async () => {
    const name = `Dup ${S}`;
    await service.create(agent(aliceId), { name, filters: {} });

    // Bob may have his own view of the same name — different owner.
    await expect(service.create(agent(bobId), { name, filters: {} })).resolves.toBeDefined();

    // Alice may not have two. Case-insensitively — "that name is taken" is
    // what a user means regardless of capitalisation.
    await expect(
      service.create(agent(aliceId), { name: name.toUpperCase(), filters: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("is workspace-wide for shared views, whoever created them", async () => {
    const name = `Shared dup ${S}`;
    await service.create(admin(aliceId), { name, visibility: "shared", filters: {} });
    // A DIFFERENT admin — a naive @@unique including createdById would allow this.
    await expect(
      service.create(admin(bobId), { name, visibility: "shared", filters: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// 3. The WHERE builder
// ---------------------------------------------------------------------------

describe("where builder", () => {
  it("returns INDEPENDENT clauses so a visibility restriction can't be clobbered", () => {
    // The regression this exists for: `{ assignedUserId: null }` spread next to
    // `{ assignedUserId: "<agent>" }` is last-wins, and the restriction
    // vanishes. As separate AND entries neither can delete the other.
    const clauses = inboxViewWhereClauses({ assignee: { kind: "unassigned" } });
    expect(clauses).toEqual([{ assignedUserId: null }]);

    const composed = { AND: [...clauses, { assignedUserId: "agent-1" }] };
    // Both predicates survive — the pair is unsatisfiable, which is CORRECT:
    // a conversation cannot be both unassigned and assigned to me.
    expect(composed.AND).toHaveLength(2);
    expect(composed.AND[0]).toEqual({ assignedUserId: null });
    expect(composed.AND[1]).toEqual({ assignedUserId: "agent-1" });
  });

  it("treats an EMPTY list as no opinion, not as 'match nothing'", () => {
    // `{ in: [] }` matches nothing. A view saved with every status unticked
    // must show everything, not an empty inbox.
    expect(inboxViewWhereClauses({ statuses: [] })).toEqual([]);
    expect(inboxViewWhereClauses({ channels: [], tagIds: [], stageIds: [] })).toEqual([]);
  });

  it("expands tagMatch:'all' into one clause PER TAG", () => {
    // A single `some: { id: { in: [a, b] } }` is satisfied by a contact
    // carrying only `a` — it reads as AND and behaves as OR.
    const all = inboxViewWhereClauses({ tagIds: [tagAId, tagBId], tagMatch: "all" });
    expect(all).toHaveLength(2);
    expect(all).toEqual([
      { contact: { tags: { some: { id: tagAId } } } },
      { contact: { tags: { some: { id: tagBId } } } },
    ]);

    const any = inboxViewWhereClauses({ tagIds: [tagAId, tagBId], tagMatch: "any" });
    expect(any).toEqual([
      { contact: { tags: { some: { id: { in: [tagAId, tagBId] } } } } },
    ]);
  });

  it("makes a 'me' view match NOTHING without a viewer, never everything", () => {
    const clauses = inboxViewWhereClauses({ assignee: { kind: "me" } });
    // An unsatisfiable predicate — the loud-failure direction. Widening to
    // "everyone" for a machine caller is the dangerous one.
    expect(clauses).toEqual([{ id: "__no_match__" }]);

    expect(inboxViewWhereClauses({ assignee: { kind: "me" } }, "u1")).toEqual([
      { assignedUserId: "u1" },
    ]);
  });

  it("excludes tombstoned contacts from a stage filter", () => {
    // So the badge count and the list agree — the same rule the stage preset
    // carries.
    expect(inboxViewWhereClauses({ stageIds: [stageId] })).toEqual([
      { contact: { stageId: { in: [stageId] }, deletedAt: null } },
    ]);
  });

  it("emits one INDEPENDENT clause per field entry — options OR'd within, entries AND'd", () => {
    const clauses = inboxViewWhereClauses({
      fields: [
        { key: fieldKey, optionIds: [optRedId, optBlueId] },
        { key: "plan", optionIds: ["opt_x"] },
      ],
    });
    // Two entries → two AND elements. Merging them into one contact object
    // would let a later key clobber an earlier predicate — the spread bug.
    expect(clauses).toEqual([
      {
        contact: {
          deletedAt: null,
          AND: [
            {
              OR: [
                { customFields: { path: [fieldKey], equals: optRedId } },
                { customFields: { path: [fieldKey], equals: optBlueId } },
              ],
            },
          ],
        },
      },
      {
        contact: {
          deletedAt: null,
          AND: [{ OR: [{ customFields: { path: ["plan"], equals: "opt_x" } }] }],
        },
      },
    ]);
  });

  it("treats an empty fields list — and an emptied entry — as no opinion", () => {
    expect(inboxViewWhereClauses({ fields: [] })).toEqual([]);
    // Schema-impossible (optionIds.min(1)) but the builder must not turn it
    // into an unsatisfiable OR: [] either.
    expect(inboxViewWhereClauses({ fields: [{ key: fieldKey, optionIds: [] }] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Dangling references widen, they don't empty
// ---------------------------------------------------------------------------

describe("dangling references", () => {
  it("drops a deleted tag but keeps the surviving ones", async () => {
    const doomed = await prisma.tag.create({
      data: { workspaceId, name: `doomed-${S}`, color: "lime" },
    });
    const filters: InboxViewFilters = { tagIds: [tagAId, doomed.id], tagMatch: "any" };
    await prisma.tag.delete({ where: { id: doomed.id } });

    const resolved = await service.resolveFilters(workspaceId, filters);
    expect(resolved.tagIds).toEqual([tagAId]);
  });

  it("drops the field entirely when EVERY referenced id is gone", async () => {
    const doomed = await prisma.tag.create({
      data: { workspaceId, name: `doomed2-${S}`, color: "lime" },
    });
    const filters: InboxViewFilters = { tagIds: [doomed.id] };
    await prisma.tag.delete({ where: { id: doomed.id } });

    const resolved = await service.resolveFilters(workspaceId, filters);
    // Absent, NOT `[]` — the where builder must see "no opinion" and widen,
    // rather than an empty list it could turn into `in: []`.
    expect(resolved.tagIds).toBeUndefined();
    expect(inboxViewWhereClauses(resolved)).toEqual([]);
  });

  it("falls back to 'anyone' when every named teammate has left", async () => {
    const filters: InboxViewFilters = {
      assignee: { kind: "users", userIds: ["ghost-1", "ghost-2"] },
    };
    const resolved = await service.resolveFilters(workspaceId, filters);
    expect(resolved.assignee).toEqual({ kind: "anyone" });
  });

  it("keeps a teammate who IS still a member", async () => {
    const resolved = await service.resolveFilters(workspaceId, {
      assignee: { kind: "users", userIds: [aliceId, "ghost"] },
    });
    expect(resolved.assignee).toEqual({ kind: "users", userIds: [aliceId] });
  });

  it("drops dead option ids from a field entry but keeps the survivors", async () => {
    const resolved = await service.resolveFilters(workspaceId, {
      fields: [{ key: fieldKey, optionIds: [optRedId, "ghost-option"] }],
    });
    expect(resolved.fields).toEqual([{ key: fieldKey, optionIds: [optRedId] }]);
  });

  it("drops a field entry whose key no longer names a select field, and the list when emptied", async () => {
    const resolved = await service.resolveFilters(workspaceId, {
      fields: [{ key: `deleted_${S}`, optionIds: [optRedId] }],
    });
    // Absent, NOT [] — same "no opinion" rule as the tag case above.
    expect(resolved.fields).toBeUndefined();
    expect(inboxViewWhereClauses(resolved)).toEqual([]);
  });

  it("never resolves a sibling workspace's field as live", async () => {
    // Same key name in the OTHER workspace must not satisfy this one's filter.
    const foreign = await prisma.contactFieldDefinition.create({
      data: {
        workspaceId: otherWorkspaceId,
        key: `foreign_${S}`,
        label: `Foreign ${S}`,
        type: "select",
      },
    });
    const resolved = await service.resolveFilters(workspaceId, {
      fields: [{ key: foreign.key, optionIds: [optRedId] }],
    });
    expect(resolved.fields).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. The client-side mirror must agree with the server
// ---------------------------------------------------------------------------

describe("client matcher", () => {
  const row = (over: Partial<Parameters<typeof matchesInboxViewFilters>[2]> = {}) => ({
    status: "open" as const,
    channel: "whatsapp",
    assignedUserId: null,
    unreadCount: 0,
    openFlagCount: 0,
    contact: { stageId: null, tagIds: [] as string[] },
    ...over,
  });

  it("agrees with the server on the empty document — everything matches", () => {
    expect(inboxViewWhereClauses({})).toEqual([]);
    expect(matchesInboxViewFilters({}, "u1", row())).toBe(true);
  });

  it("requires ALL tags for tagMatch:'all' and ANY otherwise", () => {
    const both = row({ contact: { stageId: null, tagIds: [tagAId, tagBId] } });
    const one = row({ contact: { stageId: null, tagIds: [tagAId] } });

    expect(matchesInboxViewFilters({ tagIds: [tagAId, tagBId], tagMatch: "all" }, "u1", both)).toBe(true);
    // The OR-behaving-as-AND bug, from the client side.
    expect(matchesInboxViewFilters({ tagIds: [tagAId, tagBId], tagMatch: "all" }, "u1", one)).toBe(false);
    expect(matchesInboxViewFilters({ tagIds: [tagAId, tagBId], tagMatch: "any" }, "u1", one)).toBe(true);
  });

  it("EXCLUDES a row whose data it cannot see, rather than admitting it", () => {
    // `tagIds` undefined = this row came from a route that skips the tag JOIN.
    // A wrongly-admitted row is visible wrongness that survives until the next
    // page load; a wrongly-excluded one is fixed by the next refetch.
    const unknown = row({ contact: { stageId: null, tagIds: undefined } });
    expect(matchesInboxViewFilters({ tagIds: [tagAId] }, "u1", unknown)).toBe(false);

    const noChannel = row({ channel: undefined });
    expect(matchesInboxViewFilters({ channels: ["whatsapp"] }, "u1", noChannel)).toBe(false);
  });

  it("resolves 'me' against the VIEWER, so one shared view means different things", () => {
    const mine = row({ assignedUserId: "u1" });
    expect(matchesInboxViewFilters({ assignee: { kind: "me" } }, "u1", mine)).toBe(true);
    expect(matchesInboxViewFilters({ assignee: { kind: "me" } }, "u2", mine)).toBe(false);
  });

  it("matches field filters against the stored option id, OR within an entry", () => {
    const red = row({
      contact: { stageId: null, tagIds: [], customFields: { [fieldKey]: optRedId } },
    });
    const filters: InboxViewFilters = {
      fields: [{ key: fieldKey, optionIds: [optRedId, optBlueId] }],
    };
    expect(matchesInboxViewFilters(filters, "u1", red)).toBe(true);
    expect(
      matchesInboxViewFilters(
        { fields: [{ key: fieldKey, optionIds: [optBlueId] }] },
        "u1",
        red,
      ),
    ).toBe(false);
    // No value stored under the key at all.
    const bare = row({
      contact: { stageId: null, tagIds: [], customFields: {} },
    });
    expect(matchesInboxViewFilters(filters, "u1", bare)).toBe(false);
  });

  it("EXCLUDES a row whose customFields it cannot see — same rule as tags", () => {
    // `customFields` undefined = built by a route that skips the column.
    const unknown = row({ contact: { stageId: null, tagIds: [], customFields: undefined } });
    expect(
      matchesInboxViewFilters(
        { fields: [{ key: fieldKey, optionIds: [optRedId] }] },
        "u1",
        unknown,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Counts partitioning + the summary line
// ---------------------------------------------------------------------------

describe("helpers", () => {
  it("flags exactly the views whose counts cannot be shared across agents", () => {
    // Load-bearing for the counts cache: a view that never says `me` produces
    // the same number for everyone, so ONE query serves the whole team.
    expect(inboxViewIsViewerScoped({ assignee: { kind: "me" } })).toBe(true);
    expect(inboxViewIsViewerScoped({ assignee: { kind: "unassigned" } })).toBe(false);
    expect(inboxViewIsViewerScoped({ assignee: { kind: "users", userIds: ["u1"] } })).toBe(false);
    expect(inboxViewIsViewerScoped({})).toBe(false);
  });

  it("summarizes a filter without ever printing a raw id", () => {
    const text = summarizeInboxViewFilters(
      { statuses: ["open"], assignee: { kind: "unassigned" }, tagIds: [tagAId] },
      { tagNames: { [tagAId]: "VIP" } },
    );
    expect(text).toBe("Open · Unassigned · VIP");

    // Unresolvable ids degrade to a count, never a cuid in the UI.
    const unresolved = summarizeInboxViewFilters({ tagIds: ["a", "b"] });
    expect(unresolved).toBe("2 tags");

    expect(summarizeInboxViewFilters({})).toBe("All conversations");
  });
});

// ---------------------------------------------------------------------------
// 7. Cap + normalisation
// ---------------------------------------------------------------------------

describe("guards", () => {
  it("normalises an explicitly-empty list away at save time", async () => {
    const created = await service.create(agent(aliceId), {
      name: `Normalised ${S}`,
      // A UI bug could send these; stored as-is they read as a filter and
      // behave as none, which is the confusing combination.
      filters: { statuses: [], tagIds: [], stageIds: [] },
    });
    expect(created.filters).toEqual({});
  });

  it("caps the number of views per scope", async () => {
    // Fill Bob's personal scope to the limit, then prove the next one fails.
    const { MAX_INBOX_VIEWS_PER_SCOPE } = await import("@ccp/shared/inbox-views/types");
    const existing = (await service.list(agent(bobId))).filter(
      (v) => v.visibility === "personal",
    ).length;
    for (let i = existing; i < MAX_INBOX_VIEWS_PER_SCOPE; i++) {
      await service.create(agent(bobId), { name: `Bulk ${i} ${S}`, filters: {} });
    }
    await expect(
      service.create(agent(bobId), { name: `One too many ${S}`, filters: {} }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// 8. End to end: the document really becomes a narrower list
// ---------------------------------------------------------------------------

describe("listConversations honours a view", () => {
  let seq = 0;
  /** One conversation, with the attributes a view can select on. */
  async function seed(over: {
    status?: "open" | "pending" | "closed";
    assignedUserId?: string | null;
    channel?: "whatsapp" | "instagram";
    tagIds?: string[];
    unreadCount?: number;
  }) {
    const contact = await prisma.contact.create({
      data: {
        workspaceId,
        name: `IV C${seq}`,
        phoneNumber: `+9855${S}${String(seq++).padStart(3, "0")}`,
        identityChannel: "whatsapp",
        ...(over.tagIds?.length ? { tags: { connect: over.tagIds.map((id) => ({ id })) } } : {}),
      },
      select: { id: true },
    });
    const convo = await prisma.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        channel: over.channel ?? "whatsapp",
        status: over.status ?? "open",
        assignedUserId: over.assignedUserId ?? null,
        unreadCount: over.unreadCount ?? 0,
      },
      select: { id: true },
    });
    return convo.id;
  }

  let unassignedOpen = "";
  let assignedToAlice = "";
  let closedTagged = "";

  beforeAll(async () => {
    unassignedOpen = await seed({ status: "open", assignedUserId: null });
    assignedToAlice = await seed({ status: "open", assignedUserId: aliceId, unreadCount: 3 });
    closedTagged = await seed({ status: "closed", tagIds: [tagAId], channel: "instagram" });
  });

  const ids = async (filters: InboxViewFilters, viewerUserId?: string) =>
    (
      await listConversations(workspaceId, {
        filter: { kind: "view", filters },
        ...(viewerUserId ? { viewerUserId } : {}),
      })
    ).items.map((r) => r.conversation.id);

  it("narrows to exactly the matching conversations", async () => {
    const open = await ids({ statuses: ["open"], assignee: { kind: "unassigned" } });
    expect(open).toContain(unassignedOpen);
    expect(open).not.toContain(assignedToAlice);
    expect(open).not.toContain(closedTagged);
  });

  it("composes several criteria as AND, not OR", async () => {
    // Closed AND instagram AND tagged — all three must hold.
    const both = await ids({
      statuses: ["closed"],
      channels: ["instagram"],
      tagIds: [tagAId],
    });
    expect(both).toEqual([closedTagged]);

    // One criterion contradicted → nothing, proving it isn't an OR.
    expect(await ids({ statuses: ["closed"], channels: ["whatsapp"], tagIds: [tagAId] })).toEqual([]);
  });

  it("resolves `me` against the viewer", async () => {
    expect(await ids({ assignee: { kind: "me" } }, aliceId)).toContain(assignedToAlice);
    expect(await ids({ assignee: { kind: "me" } }, bobId)).not.toContain(assignedToAlice);
  });

  it("CANNOT escape the agent-visibility restriction", async () => {
    // THE regression this whole file exists for. An "Unassigned" view asks for
    // `assignedUserId: null`; a restricted agent is pinned to
    // `assignedUserId: <them>`. Merged by spread, last-wins deletes the
    // restriction and the agent sees every unassigned thread in the workspace.
    const leaked = await listConversations(workspaceId, {
      filter: { kind: "view", filters: { assignee: { kind: "unassigned" } } },
      viewerUserId: aliceId,
      visibility: { assignedUserId: aliceId },
    });
    // Unsatisfiable by construction — a thread cannot be both unassigned and
    // assigned to Alice — so the correct answer is NOTHING, not "all unassigned".
    expect(leaked.items).toEqual([]);

    // And the restriction still admits what it should.
    const mine = await listConversations(workspaceId, {
      filter: { kind: "view", filters: { statuses: ["open"] } },
      viewerUserId: aliceId,
      visibility: { assignedUserId: aliceId },
    });
    expect(mine.items.map((r) => r.conversation.id)).toEqual([assignedToAlice]);
  });

  it("counts the same set the list returns", async () => {
    const filters: InboxViewFilters = { statuses: ["open"], assignee: { kind: "unassigned" } };
    const counts = new InboxViewCountsService(prisma as unknown as DbService);
    const got = await counts.countAll(workspaceId, [{ id: "v1", filters }], {
      userId: aliceId,
      workspaceId,
      role: "admin",
    });
    // A badge that disagrees with the list it labels is the thing users report
    // as "the number is wrong".
    expect(got.v1.total).toBe((await ids(filters)).length);
  });

  it("counts unread separately from the total", async () => {
    const counts = new InboxViewCountsService(prisma as unknown as DbService);
    const got = await counts.countAll(
      workspaceId,
      [{ id: "mine", filters: { assignee: { kind: "me" } } }],
      { userId: aliceId, workspaceId, role: "admin" },
    );
    expect(got.mine.total).toBe(1);
    expect(got.mine.unread).toBe(1);
  });
});
