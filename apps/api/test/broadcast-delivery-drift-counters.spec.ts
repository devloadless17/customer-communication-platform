/**
 * Parent-counter reconcile in the broadcast-delivery-drift sweeper.
 *
 * `Broadcast.sentCount`/`failedCount` are runner-maintained increments; a lane
 * dying past its retries leaves them short of the truth the
 * `BroadcastRecipient` rows hold, permanently — this sweeper half recomputes
 * them for RECENT terminal campaigns. Pinned here (it shipped 2026-08-11 with
 * no coverage, flagged by the completeness review):
 *   - a recent terminal campaign's counters converge to the recipient truth;
 *   - a campaign OUTSIDE the 7-day window is left alone (the same bound that
 *     keeps the recipient aggregate from scanning the whole table);
 *   - a RUNNING campaign is never touched (its lanes own the counters).
 *
 *   pnpm --filter @ccp/api exec vitest run test/broadcast-delivery-drift-counters.spec.ts
 */
import { existsSync } from "node:fs";

import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { sweepBroadcastDeliveryDriftOnce } from "@/lib/sweepers/broadcast-delivery-drift";
import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `bdd${Date.now() % 1e8}`;
let orgId = "";
let workspaceId = "";
const contactIds: string[] = [];

async function mkBroadcast(args: {
  status: "completed" | "running";
  ageDays: number;
  sentCount: number;
  failedCount: number;
  recipients: Array<"sent" | "failed">;
}): Promise<string> {
  const b = await prisma.broadcast.create({
    data: {
      workspaceId,
      name: `${S}-${args.status}-${args.ageDays}d`,
      channel: "whatsapp",
      status: args.status,
      audienceMode: "selected",
      variables: {},
      totalCount: args.recipients.length,
      sentCount: args.sentCount,
      failedCount: args.failedCount,
      completedAt: args.status === "completed" ? new Date(Date.now() - args.ageDays * 86400_000) : null,
    },
  });
  await prisma.broadcastRecipient.createMany({
    data: args.recipients.map((status, i) => ({
      broadcastId: b.id,
      contactId: contactIds[i % contactIds.length]!,
      status,
    })),
  });
  // Age the row past the sweeper's 10-minute settle guard (and, for the
  // out-of-window case, past RECENT_MS). The guard reads
  // COALESCE(completedAt, createdAt); completedAt is aged via `create` above,
  // createdAt only settable raw.
  await prisma.$executeRaw`
    UPDATE "Broadcast" SET "createdAt" = NOW() - make_interval(days => ${args.ageDays}, mins => 30)
    WHERE id = ${b.id}`;
  return b.id;
}

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `BDD Org ${S}`, status: "active" } })).id;
  workspaceId = (await prisma.workspace.create({ data: { name: `BDD WS ${S}`, organizationId: orgId } })).id;
  for (let i = 0; i < 4; i++) {
    contactIds.push(
      (
        await prisma.contact.create({
          data: { workspaceId, name: `BDD Contact ${i}`, identityChannel: "whatsapp", phoneNumber: `9615500${S.slice(-4)}${i}` },
        })
      ).id,
    );
  }
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("broadcast-delivery-drift parent counters", () => {
  it("recomputes a recent terminal campaign, leaves out-of-window and running ones alone", async () => {
    const recent = await mkBroadcast({
      status: "completed",
      ageDays: 1,
      sentCount: 1, // lane died: truth is 3 sent / 1 failed
      failedCount: 0,
      recipients: ["sent", "sent", "sent", "failed"],
    });
    const ancient = await mkBroadcast({
      status: "completed",
      ageDays: 9, // outside RECENT_MS — reconcile scope ends with the window
      sentCount: 1,
      failedCount: 0,
      recipients: ["sent", "sent"],
    });
    const running = await mkBroadcast({
      status: "running",
      ageDays: 1,
      sentCount: 1, // its lanes own these — recompute would race them
      failedCount: 0,
      recipients: ["sent", "sent"],
    });

    await sweepBroadcastDeliveryDriftOnce();

    const [r, a, run] = await Promise.all(
      [recent, ancient, running].map((id) =>
        prisma.broadcast.findUniqueOrThrow({ where: { id }, select: { sentCount: true, failedCount: true } }),
      ),
    );
    expect(r).toEqual({ sentCount: 3, failedCount: 1 });
    expect(a).toEqual({ sentCount: 1, failedCount: 0 });
    expect(run).toEqual({ sentCount: 1, failedCount: 0 });
  });
});
