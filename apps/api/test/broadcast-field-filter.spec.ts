/**
 * Select-field predicates on broadcast audiences — the AND-narrowing contract.
 *
 * What must hold (and why it's worth a spec):
 *   1. A field predicate NARROWS the tag∪contact union — hand-picked contacts
 *      included. Exempting manual picks would silently defeat the guard-like
 *      intent ("only Arabic speakers get this template").
 *   2. Count, preview and member resolution answer from the SAME set — the
 *      number the operator confirms against is the number that sends.
 *   3. A stale/foreign option id matches NOTHING, never widens. An audience
 *      feeds billed, irreversible sends; dropping a dead predicate (the inbox
 *      views' policy) would widen one silently.
 *   4. `ownedFieldFilters` prunes cross-workspace ids at group-save time —
 *      the same id-stuffing defense as ownedTagIds.
 *
 *   pnpm --filter @ccp/api exec vitest run test/broadcast-field-filter.spec.ts
 */
import { existsSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  contactFieldFilterClauses,
  ownedFieldFilters,
  parseStoredFieldFilters,
} from "@/lib/contact-fields/filter-where";
import {
  countAudienceContacts,
  previewAudienceContacts,
  resolveAudienceGroupMembers,
} from "@/lib/queries";
import { setSharedDb } from "@/lib/db";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();

const S = `bf${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let otherWorkspaceId = "";
let tagId = "";
let fieldKey = "";
let optAdId = "";
let optRefId = "";
/** Tagged + Ad. */
let taggedAdId = "";
/** Tagged + Referral. */
let taggedRefId = "";
/** Hand-picked (untagged), NO field value. */
let manualBareId = "";

beforeAll(async () => {
  setSharedDb(prisma as unknown as Parameters<typeof setSharedDb>[0]);

  orgId = (
    await prisma.organization.create({
      data: { name: `BF Org ${S}`, status: "active", maxWorkspaces: 100 },
    })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `BF ws ${S}`, organizationId: orgId } })
  ).id;
  otherWorkspaceId = (
    await prisma.workspace.create({ data: { name: `BF other ${S}`, organizationId: orgId } })
  ).id;

  tagId = (
    await prisma.tag.create({ data: { workspaceId, name: `vip-${S}`, color: "rose" } })
  ).id;

  fieldKey = `src_${S}`;
  const def = await prisma.contactFieldDefinition.create({
    data: { workspaceId, key: fieldKey, label: `Src ${S}`, type: "select" },
  });
  optAdId = (
    await prisma.contactFieldOption.create({
      data: { workspaceId, fieldId: def.id, name: `Ad ${S}`, color: "rose", position: 0 },
    })
  ).id;
  optRefId = (
    await prisma.contactFieldOption.create({
      data: { workspaceId, fieldId: def.id, name: `Referral ${S}`, color: "sky", position: 1 },
    })
  ).id;

  const mkContact = async (
    n: number,
    opts: { tagged?: boolean; optionId?: string },
  ): Promise<string> => {
    const c = await prisma.contact.create({
      data: {
        workspaceId,
        name: `BF Contact ${n} ${S}`,
        phoneNumber: `9615550${n}${S.slice(-4)}`,
        identityChannel: "whatsapp",
        customFields: opts.optionId ? { [fieldKey]: opts.optionId } : {},
        ...(opts.tagged ? { tags: { connect: { id: tagId } } } : {}),
      },
      select: { id: true },
    });
    return c.id;
  };
  taggedAdId = await mkContact(1, { tagged: true, optionId: optAdId });
  taggedRefId = await mkContact(2, { tagged: true, optionId: optRefId });
  manualBareId = await mkContact(3, {});
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("AND-narrowing over the union", () => {
  it("narrows the tag membership to matching option values", async () => {
    const all = await countAudienceContacts(workspaceId, { tagIds: [tagId] });
    expect(all).toBe(2);
    const narrowed = await countAudienceContacts(workspaceId, {
      tagIds: [tagId],
      fieldFilters: [{ key: fieldKey, optionIds: [optAdId] }],
    });
    expect(narrowed).toBe(1);
  });

  it("ORs option ids within one entry", async () => {
    const either = await countAudienceContacts(workspaceId, {
      tagIds: [tagId],
      fieldFilters: [{ key: fieldKey, optionIds: [optAdId, optRefId] }],
    });
    expect(either).toBe(2);
  });

  it("excludes a hand-picked contact that fails the predicate — manual is not exempt", async () => {
    const ids = await resolveAudienceGroupMembers(workspaceId, {
      tagIds: [tagId],
      manualContactIds: [manualBareId],
      fieldFilters: [{ key: fieldKey, optionIds: [optAdId] }],
    });
    expect(ids).toEqual([taggedAdId]);
  });

  it("count, preview and member resolution agree on the same fixture", async () => {
    const args = {
      tagIds: [tagId],
      fieldFilters: [{ key: fieldKey, optionIds: [optRefId] }],
    };
    const count = await countAudienceContacts(workspaceId, {
      ...args,
      contactIds: [manualBareId],
    });
    const preview = await previewAudienceContacts(workspaceId, {
      ...args,
      contactIds: [manualBareId],
    });
    const members = await resolveAudienceGroupMembers(workspaceId, {
      tagIds: args.tagIds,
      manualContactIds: [manualBareId],
      fieldFilters: args.fieldFilters,
    });
    expect(count).toBe(1);
    expect(preview.total).toBe(1);
    expect(preview.sample.map((c) => c.id)).toEqual([taggedRefId]);
    expect(members).toEqual([taggedRefId]);
  });

  it("a stale option id yields the NARROWER set, never a wider one", async () => {
    // Simulates "option deleted after the filter was stored": the predicate
    // matches nothing. Match-nothing (not drop) is deliberate here — see
    // filter-where.ts; a dropped predicate silently widens a billed send.
    const count = await countAudienceContacts(workspaceId, {
      tagIds: [tagId],
      fieldFilters: [{ key: fieldKey, optionIds: ["ghost-option"] }],
    });
    expect(count).toBe(0);
  });
});

describe("ownership pruning (stored group filters)", () => {
  it("drops entries whose key belongs to another workspace, and foreign option ids", async () => {
    const foreignDef = await prisma.contactFieldDefinition.create({
      data: {
        workspaceId: otherWorkspaceId,
        key: `theirs_${S}`,
        label: `Theirs ${S}`,
        type: "select",
      },
    });
    const foreignOpt = await prisma.contactFieldOption.create({
      data: {
        workspaceId: otherWorkspaceId,
        fieldId: foreignDef.id,
        name: `Foreign ${S}`,
        color: "lime",
        position: 0,
      },
    });
    const owned = await ownedFieldFilters(workspaceId, [
      { key: fieldKey, optionIds: [optAdId, foreignOpt.id] },
      { key: foreignDef.key, optionIds: [foreignOpt.id] },
    ]);
    expect(owned).toEqual([{ key: fieldKey, optionIds: [optAdId] }]);
  });
});

describe("stored-Json parsing + clause shape", () => {
  it("parses only well-formed entries back out of a Json column", () => {
    expect(
      parseStoredFieldFilters([
        { key: fieldKey, optionIds: [optAdId] },
        { key: "", optionIds: [optAdId] }, // empty key → dropped
        { key: "x", optionIds: [] }, // no ids → dropped
        { key: "y", optionIds: [42] }, // non-string ids filtered → dropped
        "garbage",
      ]),
    ).toEqual([{ key: fieldKey, optionIds: [optAdId] }]);
    expect(parseStoredFieldFilters(null)).toEqual([]);
    expect(parseStoredFieldFilters({ key: "not-an-array" })).toEqual([]);
  });

  it("emits one independent clause per entry (the AND-array contract)", () => {
    expect(
      contactFieldFilterClauses([
        { key: "a", optionIds: ["1", "2"] },
        { key: "b", optionIds: ["3"] },
      ]),
    ).toEqual([
      {
        OR: [
          { customFields: { path: ["a"], equals: "1" } },
          { customFields: { path: ["a"], equals: "2" } },
        ],
      },
      { OR: [{ customFields: { path: ["b"], equals: "3" } }] },
    ]);
  });
});
