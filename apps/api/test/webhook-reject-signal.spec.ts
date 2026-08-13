/**
 * Webhook-403 product signal (2026-08-13).
 *
 * A webhook rejected at our door (bad_signature / no_config) used to produce a
 * server-side warn and NOTHING an admin could see — and Meta gives up on a
 * failing endpoint after ~24-36h, so a persistent signature mismatch was
 * silently-lost inbound. `recordWebhookRejected` stamps the channel's rows
 * (channel-wide: a failed signature cannot be attributed to an account),
 * throttled in-process so a Meta retry storm costs one UPDATE a minute, and
 * `recentWebhookRejection` applies the 24h staleness filter for Settings.
 *
 *   pnpm --filter @ccp/api exec vitest run test/webhook-reject-signal.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import {
  recentWebhookRejection,
  recordWebhookRejected,
} from "@/lib/providers/channel-health";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `wrs${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let waConnId = "";
let msgrConnId = "";

async function stamps(id: string) {
  return prisma.channelConnection.findUniqueOrThrow({
    where: { id },
    select: { lastWebhookRejectedAt: true, lastWebhookRejectReason: true },
  });
}

/** The recorder is fire-and-forget — poll until its write lands. */
async function waitForStamp(id: string): Promise<void> {
  await expect
    .poll(async () => (await stamps(id)).lastWebhookRejectedAt, { timeout: 5_000 })
    .not.toBeNull();
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `WRS Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `WRS WS ${S}`, organizationId: orgId } })
  ).id;
  waConnId = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_pn`,
        isActive: true,
        config: {},
        secrets: {},
      },
      select: { id: true },
    })
  ).id;
  msgrConnId = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "messenger",
        externalAccountId: `${S}_page`,
        isActive: true,
        config: {},
        secrets: {},
      },
      select: { id: true },
    })
  ).id;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("recordWebhookRejected", () => {
  it("stamps the CHANNEL's rows only, with the reason", async () => {
    recordWebhookRejected(workspaceId, "whatsapp", "bad_signature");
    await waitForStamp(waConnId);
    const wa = await stamps(waConnId);
    expect(wa.lastWebhookRejectReason).toBe("bad_signature");
    // The sibling CHANNEL is untouched — a messenger admin must not see a
    // whatsapp signature problem.
    const msgr = await stamps(msgrConnId);
    expect(msgr.lastWebhookRejectedAt).toBeNull();
  });

  it("throttles repeat writes within the window (a Meta retry storm = 1 UPDATE/min)", async () => {
    // Only Date is faked — the write itself is a real (fire-and-forget) query.
    vi.useFakeTimers({ toFake: ["Date"] });
    const before = (await stamps(waConnId)).lastWebhookRejectedAt;
    expect(before).not.toBeNull();
    // Within the 60s window: dropped before any DB work.
    recordWebhookRejected(workspaceId, "whatsapp", "no_config");
    await new Promise((r) => setTimeout(r, 150));
    expect((await stamps(waConnId)).lastWebhookRejectReason).toBe("bad_signature");
    // Past the window: the write goes through and the reason updates.
    vi.advanceTimersByTime(61_000);
    recordWebhookRejected(workspaceId, "whatsapp", "no_config");
    await expect
      .poll(async () => (await stamps(waConnId)).lastWebhookRejectReason, { timeout: 5_000 })
      .toBe("no_config");
  });
});

describe("recentWebhookRejection (the Settings staleness filter)", () => {
  it("passes a fresh stamp through and nulls a stale one", () => {
    const now = new Date();
    const fresh = recentWebhookRejection(now, "bad_signature");
    expect(fresh).toEqual({ at: now.toISOString(), reason: "bad_signature" });
    const stale = new Date(Date.now() - 25 * 60 * 60_000);
    expect(recentWebhookRejection(stale, "bad_signature")).toBeNull();
    expect(recentWebhookRejection(null, "bad_signature")).toBeNull();
    expect(recentWebhookRejection(now, null)).toBeNull();
  });
});
