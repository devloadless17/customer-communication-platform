/**
 * Regression guards for defects found in the pre-launch audit of the
 * Team→Workspace tenancy restructure. Each `it` pins one confirmed bug that a
 * refactor could silently reintroduce.
 *
 *   pnpm --filter @ccp/api exec vitest run test/restructure-security.spec.ts
 */
import { existsSync } from "node:fs";

import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { normalizeDefaultAccount } from "@/lib/providers/normalize-default-account";
import { UsersService } from "@/users/users.service";
import type { DbService } from "@/db/db.service";
import type { EventBus } from "@/events/event-bus.module";
import type { SessionInvalidationService } from "@/auth/session-invalidation.service";
import type { UserActor } from "@ccp/shared/auth/permissions";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();

const S = `rsec${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";

beforeAll(async () => {
  setSharedDb(prisma as unknown as Parameters<typeof setSharedDb>[0]);
  orgId = (await prisma.organization.create({ data: { name: `RSEC ${S}`, status: "active" } })).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `RSEC WS ${S}`, organizationId: orgId } })
  ).id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// CRITICAL — the "" placeholder must never remain the default over a real
// credentialed account (else every inbound webhook 403s and default sends fail)
// ---------------------------------------------------------------------------

describe("normalizeDefaultAccount", () => {
  const realId = `${S}_real`;

  beforeEach(async () => {
    await prisma.channelConnection.deleteMany({ where: { workspaceId, channel: "whatsapp" } });
  });

  /** Reproduce the exact post-onboarding state: an inactive "" placeholder that
   *  getConfig minted as isDefault, plus the real account created non-default. */
  async function seedPlaceholderThenReal() {
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: "",
        isDefault: true,
        isActive: false,
        config: {},
        secrets: {},
      },
    });
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: realId,
        isDefault: false,
        isActive: true,
        config: { phoneNumberId: realId },
        secrets: {},
      },
    });
  }

  it("deletes the placeholder and promotes the real account to sole default", async () => {
    await seedPlaceholderThenReal();
    await normalizeDefaultAccount(workspaceId, "whatsapp", realId);

    const rows = await prisma.channelConnection.findMany({
      where: { workspaceId, channel: "whatsapp" },
      select: { externalAccountId: true, isDefault: true, isActive: true },
    });
    // The placeholder is gone…
    expect(rows.find((r) => r.externalAccountId === "")).toBeUndefined();
    // …and the real, active account is the one and only default.
    const defaults = rows.filter((r) => r.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.externalAccountId).toBe(realId);
    expect(defaults[0]!.isActive).toBe(true);
  });

  it("is idempotent — a second call leaves exactly one default", async () => {
    await seedPlaceholderThenReal();
    await normalizeDefaultAccount(workspaceId, "whatsapp", realId);
    await normalizeDefaultAccount(workspaceId, "whatsapp", realId);
    const defaults = await prisma.channelConnection.count({
      where: { workspaceId, channel: "whatsapp", isDefault: true },
    });
    expect(defaults).toBe(1);
  });

  it("does NOT steal the default from an established active account", async () => {
    // A second number being connected must not demote the existing default.
    const firstId = `${S}_first`;
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: firstId,
        isDefault: true,
        isActive: true,
        config: { phoneNumberId: firstId },
        secrets: {},
      },
    });
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: realId,
        isDefault: false,
        isActive: true,
        config: { phoneNumberId: realId },
        secrets: {},
      },
    });
    await normalizeDefaultAccount(workspaceId, "whatsapp", realId);

    const defaults = await prisma.channelConnection.findMany({
      where: { workspaceId, channel: "whatsapp", isDefault: true },
      select: { externalAccountId: true },
    });
    // The originally-default account keeps the default; the newcomer does not.
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.externalAccountId).toBe(firstId);
  });
});

// ---------------------------------------------------------------------------
// HIGH — a role change must write WorkspaceMember.role, not User.role (which
// no longer exists → runtime crash on every directory role change)
// ---------------------------------------------------------------------------

describe("UsersService.update role", () => {
  const noopBus = { publish: async () => {} } as unknown as EventBus;
  const noopInvalidator = {
    revoke: () => {},
    bustCache: () => {},
  } as unknown as SessionInvalidationService;
  const service = new UsersService(
    prisma as unknown as DbService,
    noopBus,
    noopInvalidator,
  );
  // An org admin acting: may assign admin/manager/agent.
  const actor: UserActor = { role: "admin", isSuperAdmin: false };

  async function makeMember(role: "admin" | "manager" | "agent") {
    const u = await prisma.user.create({
      data: {
        organizationId: orgId,
        orgRole: "member",
        name: `M ${role} ${Math.random()}`,
        email: `m-${role}-${Math.random().toString(36).slice(2)}-${S}@example.test`,
      },
      select: { id: true },
    });
    await prisma.workspaceMember.create({
      data: { userId: u.id, workspaceId, role },
    });
    return u.id;
  }

  it("writes the new role to WorkspaceMember (no User.role column to crash on)", async () => {
    // Two admins so the last-admin guard doesn't block the demotion.
    await makeMember("admin");
    const target = await makeMember("admin");

    // Before the fix this threw PrismaClientValidationError: Unknown argument 'role'.
    await service.update(workspaceId, actor, "actor-not-target", target, {
      role: "agent",
    });

    const membership = await prisma.workspaceMember.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: target, workspaceId } },
      select: { role: true },
    });
    expect(membership.role).toBe("agent");
  });

  it("promotes an agent to admin in this workspace", async () => {
    const target = await makeMember("agent");
    await service.update(workspaceId, actor, "actor-not-target", target, {
      role: "admin",
    });
    const membership = await prisma.workspaceMember.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: target, workspaceId } },
      select: { role: true },
    });
    expect(membership.role).toBe("admin");
  });

  it("still refuses to demote the LAST admin of the workspace", async () => {
    // Fresh workspace with exactly one admin.
    const soloWs = (
      await prisma.workspace.create({ data: { name: `RSEC solo ${S}`, organizationId: orgId } })
    ).id;
    const onlyAdmin = (
      await prisma.user.create({
        data: {
          organizationId: orgId,
          orgRole: "member",
          name: `solo ${S}`,
          email: `solo-${S}@example.test`,
        },
        select: { id: true },
      })
    ).id;
    await prisma.workspaceMember.create({
      data: { userId: onlyAdmin, workspaceId: soloWs, role: "admin" },
    });

    await expect(
      service.update(soloWs, actor, "actor-not-target", onlyAdmin, { role: "agent" }),
    ).rejects.toThrow();

    // Unchanged — still admin.
    const membership = await prisma.workspaceMember.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: onlyAdmin, workspaceId: soloWs } },
      select: { role: true },
    });
    expect(membership.role).toBe("admin");
  });
});
