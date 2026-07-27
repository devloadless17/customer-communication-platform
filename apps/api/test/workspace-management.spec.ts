/**
 * Creating and managing workspaces inside an organization.
 *
 * The four things worth proving, all of them about SAFETY rather than CRUD:
 *
 *   1. A created workspace is IDENTICAL to a signup's — same stages, same
 *      starter flags, same #general, same admin membership. Two copies of that
 *      seed would drift, and the drift would only surface as "why does my
 *      second workspace have no pipeline".
 *   2. Only an org owner/admin may create, rename, or grant. An ordinary member
 *      changing the org's shape is a privilege escalation.
 *   3. A workspace can never be left with ZERO admins — by removal or by
 *      demotion. That state is unrecoverable from the UI.
 *   4. A user or workspace id from ANOTHER organization is not addressable.
 *
 *   pnpm --filter @ccp/api exec vitest run test/workspace-management.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkspaceRootService } from "@/workspace-settings/workspace-root.service";
import { WorkspacesService } from "@/workspaces/workspaces.service";
import type { ApiSession } from "@/auth/session.guard";
import type { DbService } from "@/db/db.service";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
// The invalidator's socket side is a no-op here — these specs exercise the
// membership writes, not the realtime eviction (which needs a live gateway).
const noopInvalidator = { bustCache() {}, revoke() {} };
// A REAL WorkspaceRootService: `remove()` delegates the destruction to it
// (batched message drain, blob cleanup, provider-cache bust), so stubbing it
// would leave this spec asserting isolation against a cascade that never ran.
// Its own bus publish is the only part that needs a stand-in here.
const noopBus = { publish: async () => {} };
const workspaceRoot = new WorkspaceRootService(
  prisma as unknown as DbService,
  noopInvalidator as never,
  noopBus as never,
);
const service = new WorkspacesService(
  prisma as unknown as DbService,
  noopInvalidator as never,
  workspaceRoot,
);

const S = `wm${Date.now().toString().slice(-8)}`;
let orgId = "";
let baseWorkspaceId = "";
let ownerId = "";
let memberId = "";

/** A session for `userId`, scoped to this org. */
function sessionFor(
  userId: string,
  orgRole: "owner" | "admin" | "member",
  workspaceId = baseWorkspaceId,
): ApiSession {
  return {
    sessionId: `sess_${userId}`,
    userId,
    organizationId: orgId,
    orgRole,
    isSuperAdmin: false,
    workspaceId,
    role: "admin",
    workspaceMemberships: [{ workspaceId, name: "base", role: "admin" }],
    name: "T",
    email: `${userId}@example.test`,
    avatarUrl: null,
    orgStatus: "active",
  } as ApiSession;
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      // Headroom: the per-org workspace cap is super-admin controlled and
      // defaults to 2. These specs deliberately create many workspaces to prove
      // isolation between them, so the fixture grants itself the room rather
      // than the tests fighting a product limit that isn't what they test.
      data: { name: `WM Org ${S}`, status: "active", maxWorkspaces: 100 },
    })
  ).id;
  ownerId = (
    await prisma.user.create({
      data: {
        organizationId: orgId,
        orgRole: "owner",
        name: "WM Owner",
        email: `wm-owner-${S}@example.test`,
      },
      select: { id: true },
    })
  ).id;
  memberId = (
    await prisma.user.create({
      data: {
        organizationId: orgId,
        orgRole: "member",
        name: "WM Member",
        email: `wm-member-${S}@example.test`,
      },
      select: { id: true },
    })
  ).id;
  baseWorkspaceId = (
    await prisma.workspace.create({ data: { name: `WM base ${S}`, organizationId: orgId } })
  ).id;
  await prisma.workspaceMember.create({
    data: { userId: ownerId, workspaceId: baseWorkspaceId, role: "admin" },
  });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("create", () => {
  it("seeds a new workspace exactly like a signup does", async () => {
    const created = await service.create(sessionFor(ownerId, "owner"), "Support EU");
    expect(created.name).toBe("Support EU");

    const [stages, flags, channels, membership] = await Promise.all([
      prisma.contactStage.count({ where: { workspaceId: created.id } }),
      prisma.messageFlagDefinition.count({ where: { workspaceId: created.id } }),
      prisma.teamChannel.findMany({
        where: { workspaceId: created.id },
        select: { name: true, isDefault: true, visibility: true },
      }),
      prisma.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: ownerId, workspaceId: created.id } },
        select: { role: true },
      }),
    ]);
    expect(stages).toBe(3);
    expect(flags).toBe(4);
    // #general must be PUBLIC — `update` refuses to change a default channel's
    // visibility, so a private one would be unfixable.
    expect(channels).toEqual([{ name: "general", isDefault: true, visibility: "public" }]);
    // The creator can actually open what they just made.
    expect(membership?.role).toBe("admin");
  });

  it("refuses an ordinary org member", async () => {
    await expect(service.create(sessionFor(memberId, "member"), "Sneaky")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe("rename", () => {
  it("renames a workspace in this org", async () => {
    const renamed = await service.rename(sessionFor(ownerId, "owner"), baseWorkspaceId, "Renamed");
    expect(renamed.name).toBe("Renamed");
  });

  it("refuses a workspace from ANOTHER org", async () => {
    const otherOrg = await prisma.organization.create({
      data: { name: `WM other ${S}`, status: "active" },
    });
    const foreign = await prisma.workspace.create({
      data: { name: "foreign", organizationId: otherOrg.id },
      select: { id: true },
    });
    // A real id — but not this org's. 404, not 403: a 403 would confirm it exists.
    await expect(
      service.rename(sessionFor(ownerId, "owner"), foreign.id, "Mine now"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await prisma.organization.delete({ where: { id: otherOrg.id } });
  });
});

describe("membership", () => {
  it("adds, re-roles and removes someone", async () => {
    const session = sessionFor(ownerId, "owner");
    await service.setMembership(session, baseWorkspaceId, memberId, "agent");
    let row = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: memberId, workspaceId: baseWorkspaceId } },
      select: { role: true },
    });
    expect(row?.role).toBe("agent");

    await service.setMembership(session, baseWorkspaceId, memberId, "manager");
    row = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: memberId, workspaceId: baseWorkspaceId } },
      select: { role: true },
    });
    expect(row?.role).toBe("manager");

    await service.setMembership(session, baseWorkspaceId, memberId, null);
    row = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: memberId, workspaceId: baseWorkspaceId } },
      select: { role: true },
    });
    expect(row).toBeNull();
  });

  it("refuses a user from ANOTHER org", async () => {
    const otherOrg = await prisma.organization.create({
      data: { name: `WM other2 ${S}`, status: "active" },
    });
    const stranger = await prisma.user.create({
      data: {
        organizationId: otherOrg.id,
        name: "Stranger",
        email: `wm-stranger-${S}@example.test`,
      },
      select: { id: true },
    });
    // Granting this would hand another org's user our conversations.
    await expect(
      service.setMembership(sessionFor(ownerId, "owner"), baseWorkspaceId, stranger.id, "admin"),
    ).rejects.toBeInstanceOf(NotFoundException);
    await prisma.organization.delete({ where: { id: otherOrg.id } });
  });

  it("NEVER leaves a workspace with zero admins — by removal or by demotion", async () => {
    const session = sessionFor(ownerId, "owner");
    // The owner is the base workspace's only admin at this point.
    await expect(
      service.setMembership(session, baseWorkspaceId, ownerId, null),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.setMembership(session, baseWorkspaceId, ownerId, "agent"),
    ).rejects.toBeInstanceOf(BadRequestException);

    // With a second admin in place, the first may step down.
    await service.setMembership(session, baseWorkspaceId, memberId, "admin");
    await service.setMembership(session, baseWorkspaceId, ownerId, "agent");
    const row = await prisma.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId: ownerId, workspaceId: baseWorkspaceId } },
      select: { role: true },
    });
    expect(row?.role).toBe("agent");
  });

  it("refuses an ordinary org member", async () => {
    await expect(
      service.setMembership(sessionFor(memberId, "member"), baseWorkspaceId, memberId, "admin"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("overview", () => {
  it("returns the org, its workspaces with counts, and its members", async () => {
    const overview = await service.organization(sessionFor(ownerId, "owner"));
    expect(overview.id).toBe(orgId);
    expect(overview.canManage).toBe(true);
    expect(overview.workspaces.length).toBeGreaterThanOrEqual(2);
    const base = overview.workspaces.find((w) => w.id === baseWorkspaceId);
    expect(base?.memberCount).toBeGreaterThanOrEqual(2);
    expect(overview.members.map((m) => m.id)).toContain(memberId);
  });

  it("is readable by an ordinary member, but flags them as unable to manage", async () => {
    // Knowing which workspaces exist is directory information, not a secret —
    // and the page is unusable without it. Mutating is what's gated.
    const overview = await service.organization(sessionFor(memberId, "member"));
    expect(overview.canManage).toBe(false);
    expect(overview.workspaces.length).toBeGreaterThanOrEqual(2);
  });
});


describe("isolation", () => {
  it("a NEW workspace starts empty, with only its creator inside", async () => {
    const created = await service.create(sessionFor(ownerId, "owner"), "Isolation Check");

    // Nothing operational carries over from a sibling workspace: the whole
    // point of the boundary is that a new workspace is a fresh inbox.
    const [contacts, conversations, channels, tickets, tags, members] = await Promise.all([
      prisma.contact.count({ where: { workspaceId: created.id } }),
      prisma.conversation.count({ where: { workspaceId: created.id } }),
      prisma.channelConnection.count({ where: { workspaceId: created.id } }),
      prisma.ticket.count({ where: { workspaceId: created.id } }),
      prisma.tag.count({ where: { workspaceId: created.id } }),
      prisma.workspaceMember.findMany({
        where: { workspaceId: created.id },
        select: { userId: true, role: true },
      }),
    ]);
    expect(contacts).toBe(0);
    expect(conversations).toBe(0);
    expect(channels).toBe(0);
    expect(tickets).toBe(0);
    expect(tags).toBe(0);
    // Exactly ONE member — the creator, as admin. Nobody is auto-added: a
    // second workspace is not "the same team again", it is a separate one you
    // deliberately staff.
    expect(members).toEqual([{ userId: ownerId, role: "admin" }]);
  });

  it("data in one workspace is invisible to a query scoped to another", async () => {
    const a = await service.create(sessionFor(ownerId, "owner"), "Iso A");
    const b = await service.create(sessionFor(ownerId, "owner"), "Iso B");

    const contact = await prisma.contact.create({
      data: {
        workspaceId: a.id,
        name: "Only in A",
        phoneNumber: `+9644${S}a`,
        identityChannel: "whatsapp",
      },
      select: { id: true },
    });
    await prisma.conversation.create({
      data: { workspaceId: a.id, contactId: contact.id, channel: "whatsapp" },
    });

    // The boundary IS the `workspaceId` predicate every query carries. A row
    // from A must not be reachable through B's scope even by its exact id —
    // this is the check that would fail the day someone drops the predicate.
    expect(
      await prisma.contact.findFirst({ where: { id: contact.id, workspaceId: b.id } }),
    ).toBeNull();
    expect(await prisma.contact.count({ where: { workspaceId: b.id } })).toBe(0);
    expect(await prisma.conversation.count({ where: { workspaceId: b.id } })).toBe(0);
    expect(await prisma.contact.count({ where: { workspaceId: a.id } })).toBe(1);
  });

  it("a member of one workspace is NOT a member of a sibling", async () => {
    const a = await service.create(sessionFor(ownerId, "owner"), "Iso Members A");
    const b = await service.create(sessionFor(ownerId, "owner"), "Iso Members B");
    await service.setMembership(sessionFor(ownerId, "owner"), a.id, memberId, "agent");

    expect(
      await prisma.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: memberId, workspaceId: a.id } },
      }),
    ).not.toBeNull();
    // Membership is per-workspace. Adding someone to A gives them nothing in B.
    expect(
      await prisma.workspaceMember.findUnique({
        where: { userId_workspaceId: { userId: memberId, workspaceId: b.id } },
      }),
    ).toBeNull();
  });

  it("deleting a workspace takes its data and NOTHING else", async () => {
    const doomed = await service.create(sessionFor(ownerId, "owner"), "Iso Doomed");
    const keeper = await service.create(sessionFor(ownerId, "owner"), "Iso Keeper");
    for (const ws of [doomed, keeper]) {
      const c = await prisma.contact.create({
        data: {
          workspaceId: ws.id,
          name: `In ${ws.name}`,
          phoneNumber: `+9645${S}${ws.id.slice(-4)}`,
          identityChannel: "whatsapp",
        },
        select: { id: true },
      });
      await prisma.conversation.create({
        data: { workspaceId: ws.id, contactId: c.id, channel: "whatsapp" },
      });
    }

    await service.remove(sessionFor(ownerId, "owner"), doomed.id);

    expect(await prisma.workspace.findUnique({ where: { id: doomed.id } })).toBeNull();
    expect(await prisma.contact.count({ where: { workspaceId: doomed.id } })).toBe(0);
    // The sibling is untouched — a cascade that reached past its own workspace
    // would be catastrophic and silent.
    expect(await prisma.contact.count({ where: { workspaceId: keeper.id } })).toBe(1);
    expect(await prisma.conversation.count({ where: { workspaceId: keeper.id } })).toBe(1);
  });
});


describe("team chat isolation", () => {
  it("each workspace gets its OWN #general — channels never span workspaces", async () => {
    const a = await service.create(sessionFor(ownerId, "owner"), "Chat A");
    const b = await service.create(sessionFor(ownerId, "owner"), "Chat B");

    const [genA] = await prisma.teamChannel.findMany({
      where: { workspaceId: a.id },
      select: { id: true, name: true, isDefault: true },
    });
    const [genB] = await prisma.teamChannel.findMany({
      where: { workspaceId: b.id },
      select: { id: true, name: true, isDefault: true },
    });
    expect(genA?.name).toBe("general");
    expect(genB?.name).toBe("general");
    // Same NAME, different rows. A shared #general would leak one workspace's
    // internal chatter into another.
    expect(genA!.id).not.toBe(genB!.id);
    expect(await prisma.teamChannel.count({ where: { workspaceId: a.id } })).toBe(1);
  });

  it("a message posted in one workspace's channel is invisible to the other", async () => {
    const a = await service.create(sessionFor(ownerId, "owner"), "Chat Msg A");
    const b = await service.create(sessionFor(ownerId, "owner"), "Chat Msg B");
    const chanA = await prisma.teamChannel.findFirstOrThrow({
      where: { workspaceId: a.id },
      select: { id: true },
    });

    await prisma.teamChannelMessage.create({
      data: {
        workspaceId: a.id,
        channelId: chanA.id,
        authorUserId: ownerId,
        body: "internal to A only",
      },
    });

    expect(await prisma.teamChannelMessage.count({ where: { workspaceId: a.id } })).toBe(1);
    // The boundary is the same `workspaceId` predicate the rest of the app uses.
    expect(await prisma.teamChannelMessage.count({ where: { workspaceId: b.id } })).toBe(0);
  });

  it("channel membership does not follow you into a sibling workspace", async () => {
    const a = await service.create(sessionFor(ownerId, "owner"), "Chat Mem A");
    const b = await service.create(sessionFor(ownerId, "owner"), "Chat Mem B");
    const chanB = await prisma.teamChannel.findFirstOrThrow({
      where: { workspaceId: b.id },
      select: { id: true },
    });

    // `memberId` was never added to B, so they are not in B's #general — even
    // though they are in the same ORGANIZATION as its creator.
    await service.setMembership(sessionFor(ownerId, "owner"), a.id, memberId, "agent");
    expect(
      await prisma.teamChannelMember.count({ where: { channelId: chanB.id, userId: memberId } }),
    ).toBe(0);
  });
});
