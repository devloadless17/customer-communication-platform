/**
 * Workspace switching — the tenant-boundary invariant.
 *
 * Switching the active workspace is the ONE place a user hands the server a
 * workspace id and asks to be scoped to it. The `ccp.ws` cookie carrying that
 * id is client input, so the only thing standing between a curious user and
 * another tenant's inbox is the membership re-validation in
 * `WorkspacesService.setActive`.
 *
 * These tests fire the real service against a real database and prove:
 *   - a member CAN switch into a workspace they belong to,
 *   - a non-member CANNOT (even though the workspace exists),
 *   - the check reads the DATABASE, not the caller's session snapshot — so a
 *     membership revoked moments ago is refused immediately rather than
 *     surviving the 15s session-cache window,
 *   - an org owner/admin may select any workspace in their OWN org, but not
 *     one belonging to a different organization.
 *
 *   pnpm --filter @ccp/api exec vitest run test/workspace-switch.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { ForbiddenException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorkspacesService } from "@/workspaces/workspaces.service";
import type { ApiSession } from "@/auth/session.guard";
import type { DbService } from "@/db/db.service";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
const service = new WorkspacesService(prisma as unknown as DbService);

const SUFFIX = `ws${Date.now().toString().slice(-8)}`;

let orgA = "";
let orgB = "";
let wsA1 = "";
let wsA2 = "";
let wsB1 = "";
let memberId = "";

/** A session as `resolveSession` would build it for `memberId` in wsA1. */
function sessionFor(overrides: Partial<ApiSession> = {}): ApiSession {
  return {
    sessionId: "sess_test",
    userId: memberId,
    organizationId: orgA,
    orgRole: "member",
    isSuperAdmin: false,
    workspaceId: wsA1,
    role: "agent",
    workspaceMemberships: [{ workspaceId: wsA1, name: "A1", role: "agent" }],
    name: "Member",
    email: `member-${SUFFIX}@example.test`,
    avatarUrl: null,
    orgStatus: "active",
    rolePermissions: {},
    agentConversationVisibility: "team",
    ...overrides,
  };
}

beforeAll(async () => {
  const a = await prisma.organization.create({
    data: { name: `A-${SUFFIX}`, status: "active" },
  });
  const b = await prisma.organization.create({
    data: { name: `B-${SUFFIX}`, status: "active" },
  });
  orgA = a.id;
  orgB = b.id;

  wsA1 = (await prisma.workspace.create({ data: { name: `A1-${SUFFIX}`, organizationId: orgA } })).id;
  wsA2 = (await prisma.workspace.create({ data: { name: `A2-${SUFFIX}`, organizationId: orgA } })).id;
  wsB1 = (await prisma.workspace.create({ data: { name: `B1-${SUFFIX}`, organizationId: orgB } })).id;

  memberId = (
    await prisma.user.create({
      data: {
        organizationId: orgA,
        name: "Member",
        email: `member-${SUFFIX}@example.test`,
      },
    })
  ).id;
  // Member of A1 only — NOT of A2.
  await prisma.workspaceMember.create({
    data: { userId: memberId, workspaceId: wsA1, role: "agent" },
  });
  // A Session row so `setActive`'s update has something to write to.
  await prisma.session.create({
    data: {
      id: "sess_test",
      userId: memberId,
      token: `tok-${SUFFIX}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
});

afterAll(async () => {
  // Dropping the orgs cascades to workspaces, users, memberships and sessions.
  await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
  await prisma.$disconnect();
});

describe("setActive", () => {
  it("lets a member switch into a workspace they belong to", async () => {
    await service.setActive(sessionFor(), wsA1);
    const row = await prisma.session.findUnique({
      where: { id: "sess_test" },
      select: { activeWorkspaceId: true },
    });
    expect(row?.activeWorkspaceId).toBe(wsA1);
  });

  it("refuses a workspace in the same org the user is NOT a member of", async () => {
    await expect(service.setActive(sessionFor(), wsA2)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("refuses a workspace belonging to another organization", async () => {
    await expect(service.setActive(sessionFor(), wsB1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("validates against the DATABASE, not the session's membership snapshot", async () => {
    // The session still CLAIMS membership of A2 — exactly what a stale 15s
    // cache (or a forged cookie replayed with an old session) looks like. The
    // service must ignore the claim and re-read the membership table.
    const stale = sessionFor({
      workspaceMemberships: [
        { workspaceId: wsA1, name: "A1", role: "agent" },
        { workspaceId: wsA2, name: "A2", role: "admin" },
      ],
    });
    await expect(service.setActive(stale, wsA2)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lets an org admin select any workspace in their own org, but not another org's", async () => {
    const orgAdmin = sessionFor({ orgRole: "admin", role: "admin" });
    await service.setActive(orgAdmin, wsA2); // implicit admin everywhere in orgA
    const row = await prisma.session.findUnique({
      where: { id: "sess_test" },
      select: { activeWorkspaceId: true },
    });
    expect(row?.activeWorkspaceId).toBe(wsA2);

    await expect(service.setActive(orgAdmin, wsB1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe("list", () => {
  it("marks exactly the active workspace and reports the per-workspace role", async () => {
    const out = await service.list(sessionFor());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: wsA1,
      role: "agent",
      isActive: true,
      joined: true,
    });
  });

  it("shows an ORG ADMIN every workspace in their org — the same set setActive accepts", async () => {
    // The three surfaces have to agree. `setActive` lets an org admin open A2
    // without a membership row (asserted above), and the Organization page marks
    // it openable — so the switcher must list it. When this returned memberships
    // only, that workspace was reachable from one page and invisible in the rail,
    // and once switched to it NOTHING was marked active because the current
    // workspace wasn't in the list being rendered.
    const out = await service.list(sessionFor({ orgRole: "admin", role: "admin" }));
    expect(out.map((w) => w.id).sort()).toEqual([wsA1, wsA2].sort());
    // ...and never another organization's.
    expect(out.some((w) => w.id === wsB1)).toBe(false);
  });

  it("distinguishes a membership from mere org authority", async () => {
    const out = await service.list(sessionFor({ orgRole: "admin", role: "admin" }));
    // A1: a real WorkspaceMember row, with the role it actually carries.
    expect(out.find((w) => w.id === wsA1)).toMatchObject({ joined: true, role: "agent" });
    // A2: reachable only because they administer the org, so `joined` is false
    // and the effective role there is admin.
    expect(out.find((w) => w.id === wsA2)).toMatchObject({ joined: false, role: "admin" });
  });

  it("shows a plain member only what they joined", async () => {
    const out = await service.list(sessionFor());
    expect(out.map((w) => w.id)).toEqual([wsA1]);
  });
});
