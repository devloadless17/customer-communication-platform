/**
 * Burst regression for the pick serializer (`withPickLock` + single-flighted
 * `loadConfig` in lib/assignment/resolve.ts).
 *
 * Reservations only compensate least_busy (they inflate `openCount`);
 * round_robin reads the CURSOR, so a burst of concurrent picks used to read
 * the same snapshot and hand every conversation in the burst to ONE agent —
 * and even after the lock landed, a COLD cache still stampeded, because each
 * concurrent miss loaded its own policy object and the in-memory cursor
 * mutation didn't propagate. This spec drives both from the worst case: a
 * concurrent burst against a cold cache must rotate exactly like a
 * sequential stream.
 */
import { existsSync } from "node:fs";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  __resetAssignmentRuntimeState,
  resolveAssignee,
} from "@/lib/assignment/resolve";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const ORG_ID = "e2e-pickburst-org";
const WS_ID = "e2e-pickburst-ws";
const AGENTS = ["e2e-pickburst-u1", "e2e-pickburst-u2", "e2e-pickburst-u3"];
let policyId = "";

beforeAll(async () => {
  await prisma.organization.upsert({
    where: { id: ORG_ID },
    create: { id: ORG_ID, name: "Pick Burst Org", status: "active" },
    update: {},
  });
  await prisma.workspace.upsert({
    where: { id: WS_ID },
    create: { id: WS_ID, name: "Pick Burst WS", organizationId: ORG_ID },
    update: {},
  });
  // Distinct createdAt so the rotation's stable order (createdAt, id) is fixed.
  for (const [i, id] of AGENTS.entries()) {
    await prisma.user.upsert({
      where: { id },
      create: {
        id,
        organizationId: ORG_ID,
        name: `Burst Agent ${i + 1}`,
        email: `${id}@e2e.local`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      },
      update: {},
    });
    await prisma.workspaceMember.upsert({
      where: { userId_workspaceId: { userId: id, workspaceId: WS_ID } },
      create: { userId: id, workspaceId: WS_ID, role: "agent" },
      update: {},
    });
  }
  const policy = await prisma.assignmentPolicy.create({
    data: {
      workspaceId: WS_ID,
      name: "burst-round-robin",
      isDefault: true,
      strategy: "round_robin",
      // No presence resolver is wired in this process, and availability tiers
      // aren't what's under test — any_active keeps the pool deterministic.
      eligibility: "any_active",
      includeAllMembers: true,
    },
    select: { id: true },
  });
  policyId = policy.id;
});

beforeEach(() => {
  __resetAssignmentRuntimeState(); // cold cache — the harder case
});

afterAll(async () => {
  await prisma.assignmentPolicy.deleteMany({ where: { workspaceId: WS_ID } });
  await prisma.workspaceMember.deleteMany({ where: { workspaceId: WS_ID } });
  await prisma.user.deleteMany({ where: { id: { in: AGENTS } } });
  await prisma.workspace.deleteMany({ where: { id: WS_ID } });
  await prisma.organization.deleteMany({ where: { id: ORG_ID } });
  await prisma.$disconnect();
});

describe("concurrent pick burst (round_robin)", () => {
  // Same reasoning as the ticket-numbering concurrency test: the per-policy
  // pick lock serializes these deliberately, so the run is as deep as the
  // burst and a loaded box overran the 5s default.
  it("a cold-cache burst of 6 rotates 2-2-2, not 6-0-0", { timeout: 20_000 }, async () => {
    const decisions = await Promise.all(
      Array.from({ length: 6 }, () =>
        resolveAssignee({
          db: prisma,
          workspaceId: WS_ID,
          ctx: { source: "inbound" },
          policyId,
        }),
      ),
    );

    const counts = new Map<string, number>();
    for (const d of decisions) {
      expect(d.userId).not.toBeNull();
      counts.set(d.userId!, (counts.get(d.userId!) ?? 0) + 1);
    }
    expect([...counts.values()].sort()).toEqual([2, 2, 2]);
  });

  it("weighted with unequal `served` doesn't dogpile the lowest-ratio member", async () => {
    // This is the case where the pick LOCK itself is load-bearing (round_robin
    // is saved by the synchronous cursor mutation on the shared object even
    // without it): with served A=0, B=2, C=2 there is no tie, so no rotation
    // tie-break — an unserialized burst of 3 reads served=0 three times and
    // hands all three to A. Serialized (correct): A, A, then the 2-2-2 tie
    // rotates to someone else — A must get exactly 2.
    const weighted = await prisma.assignmentPolicy.create({
      data: {
        workspaceId: WS_ID,
        name: "burst-weighted",
        strategy: "weighted",
        eligibility: "any_active",
        includeAllMembers: true,
        members: {
          create: AGENTS.map((userId, i) => ({
            workspaceId: WS_ID,
            userId,
            weight: 1,
            served: i === 0 ? 0 : 2,
          })),
        },
      },
      select: { id: true },
    });

    const decisions = await Promise.all(
      Array.from({ length: 3 }, () =>
        resolveAssignee({
          db: prisma,
          workspaceId: WS_ID,
          ctx: { source: "inbound" },
          policyId: weighted.id,
        }),
      ),
    );
    const toFirst = decisions.filter((d) => d.userId === AGENTS[0]).length;
    expect(toFirst).toBe(2);

    await prisma.assignmentPolicyMember.deleteMany({
      where: { policyId: weighted.id, workspaceId: WS_ID },
    });
    await prisma.assignmentPolicy.deleteMany({
      where: { id: weighted.id, workspaceId: WS_ID },
    });
  });

  it("the cursor lands in the DB so rotation survives a cache reset", async () => {
    const first = await resolveAssignee({
      db: prisma,
      workspaceId: WS_ID,
      ctx: { source: "inbound" },
      policyId,
    });
    const row = await prisma.assignmentPolicy.findFirst({
      where: { id: policyId, workspaceId: WS_ID },
      select: { cursorUserId: true },
    });
    expect(row?.cursorUserId).toBe(first.userId);

    __resetAssignmentRuntimeState();
    const second = await resolveAssignee({
      db: prisma,
      workspaceId: WS_ID,
      ctx: { source: "inbound" },
      policyId,
    });
    expect(second.userId).not.toBe(first.userId);
  });
});
