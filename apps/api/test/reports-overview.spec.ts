/**
 * Workspace performance report — the aggregates behind /reports and its /v1
 * parity route (lib/analytics/reports.ts), proven against a real database:
 *
 *   - volumes bucket per-day in the REQUESTED timezone and split by direction;
 *   - first-response / resolution avg + median come out in seconds and are
 *     null (never 0) on an empty range;
 *   - agent rows merge three independent aggregates and exclude broadcast
 *     blasts from "messages sent";
 *   - SLA counts breached vs with-SLA tickets;
 *   - the AI-only count includes a thread whose every outbound was AI and
 *     excludes one a human also answered;
 *   - tenant isolation: a sibling workspace's traffic never leaks in;
 *   - the range guard rejects inverted and over-long ranges.
 *
 *   pnpm --filter @ccp/api exec vitest run test/reports-overview.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { getWorkspaceReport, ReportRangeError } from "@/lib/analytics/reports";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `rp${Date.now().toString().slice(-8)}`;

// A fixed window: 2026-07-01 .. 2026-07-08 UTC.
const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-07-08T00:00:00.000Z");
// Inside the window.
const D1 = new Date("2026-07-02T10:00:00.000Z");
const D2 = new Date("2026-07-03T15:00:00.000Z");

let workspaceId = "";
let otherWorkspaceId = "";
let agentId = "";
let seq = 0;

async function mkConversation(opts?: {
  createdAt?: Date;
  firstResponseAt?: Date;
  firstResponseByUserId?: string;
  closedAt?: Date;
  closedByUserId?: string;
  workspace?: string;
}) {
  seq += 1;
  const ws = opts?.workspace ?? workspaceId;
  const contact = await prisma.contact.create({
    data: {
      workspaceId: ws,
      name: `Rp ${S}-${seq}`,
      identityChannel: "whatsapp",
      phoneNumber: `9615${Date.now().toString().slice(-6)}${seq}`,
    },
    select: { id: true },
  });
  return prisma.conversation.create({
    data: {
      workspaceId: ws,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      createdAt: opts?.createdAt ?? D1,
      ...(opts?.firstResponseAt ? { firstResponseAt: opts.firstResponseAt } : {}),
      ...(opts?.firstResponseByUserId
        ? { firstResponseByUserId: opts.firstResponseByUserId }
        : {}),
      ...(opts?.closedAt ? { closedAt: opts.closedAt, status: "closed" } : {}),
      ...(opts?.closedByUserId ? { closedByUserId: opts.closedByUserId } : {}),
    },
    select: { id: true },
  });
}

async function mkMessage(
  conversationId: string,
  opts: {
    direction: "in" | "out";
    timestamp: Date;
    senderUserId?: string;
    broadcastId?: string;
    channel?: "whatsapp" | "messenger";
    workspace?: string;
    aiGenerated?: boolean;
  },
) {
  seq += 1;
  const ws = opts.workspace ?? workspaceId;
  const m = await prisma.message.create({
    data: {
      workspaceId: ws,
      conversationId,
      channel: opts.channel ?? "whatsapp",
      externalId: `${S}_wamid_${seq}`,
      body: "x",
      direction: opts.direction,
      timestamp: opts.timestamp,
      ...(opts.senderUserId ? { senderUserId: opts.senderUserId } : {}),
      ...(opts.broadcastId ? { broadcastId: opts.broadcastId } : {}),
    },
    select: { id: true },
  });
  if (opts.aiGenerated) {
    await prisma.aiMessageMetadata.create({
      data: { workspaceId: ws, messageId: m.id, aiGenerated: true },
    });
  }
  return m;
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Rp Org ${S}`, status: "active" },
  });
  workspaceId = (
    await prisma.workspace.create({
      data: { name: `Rp WS ${S}`, organizationId: org.id },
    })
  ).id;
  otherWorkspaceId = (
    await prisma.workspace.create({
      data: { name: `Rp WS2 ${S}`, organizationId: org.id },
    })
  ).id;
  const agent = await prisma.user.create({
    data: {
      organizationId: org.id,
      orgRole: "member",
      name: `Agent ${S}`,
      email: `agent-${S}@example.test`,
    },
    select: { id: true },
  });
  agentId = agent.id;
  await prisma.workspaceMember.create({
    data: { workspaceId, userId: agentId, role: "agent" },
  });

  // --- Thread A: human-answered. Created D1, first response +600s by agent,
  //     closed D2 by agent (resolution = D2 - D1). 1 in / 2 out.
  const a = await mkConversation({
    createdAt: D1,
    firstResponseAt: new Date(D1.getTime() + 600_000),
    firstResponseByUserId: agentId,
    closedAt: D2,
    closedByUserId: agentId,
  });
  await mkMessage(a.id, { direction: "in", timestamp: D1 });
  await mkMessage(a.id, {
    direction: "out",
    timestamp: new Date(D1.getTime() + 600_000),
    senderUserId: agentId,
  });
  await mkMessage(a.id, {
    direction: "out",
    timestamp: new Date(D1.getTime() + 900_000),
    senderUserId: agentId,
  });

  // --- Thread B: AI-only. 1 in, 2 AI outbound, nothing human.
  const b = await mkConversation({ createdAt: D2 });
  await mkMessage(b.id, { direction: "in", timestamp: D2 });
  await mkMessage(b.id, {
    direction: "out",
    timestamp: new Date(D2.getTime() + 60_000),
    aiGenerated: true,
  });
  await mkMessage(b.id, {
    direction: "out",
    timestamp: new Date(D2.getTime() + 120_000),
    aiGenerated: true,
  });

  // --- Thread C: mixed — one AI reply then a human reply. NOT ai-only. The
  //     human reply is a broadcast blast, which must count for neither the
  //     agent tally nor break… no: broadcasts are EXCLUDED from ai-only
  //     grouping entirely, so C needs a real human message to be mixed.
  const c = await mkConversation({ createdAt: D2 });
  await mkMessage(c.id, { direction: "in", timestamp: D2 });
  await mkMessage(c.id, {
    direction: "out",
    timestamp: new Date(D2.getTime() + 60_000),
    aiGenerated: true,
  });
  await mkMessage(c.id, {
    direction: "out",
    timestamp: new Date(D2.getTime() + 120_000),
    senderUserId: agentId,
  });

  // --- SLA tickets: one met, one breached (first-response leg).
  const t = await mkConversation({ createdAt: D1 });
  await prisma.ticket.createMany({
    data: [
      {
        workspaceId,
        conversationId: t.id,
        channel: "whatsapp" as const,
        number: 990001,
        subject: `Rp met ${S}`,
        createdAt: D1,
        firstResponseDueAt: new Date(D1.getTime() + 3_600_000),
        firstResponseBreached: false,
      },
      {
        workspaceId,
        conversationId: t.id,
        channel: "whatsapp" as const,
        number: 990002,
        subject: `Rp breached ${S}`,
        createdAt: D2,
        firstResponseDueAt: new Date(D2.getTime() + 3_600_000),
        firstResponseBreached: true,
      },
    ],
  });

  // --- Sibling-workspace noise that must NOT appear in any aggregate.
  const x = await mkConversation({ createdAt: D1, workspace: otherWorkspaceId });
  await mkMessage(x.id, { direction: "in", timestamp: D1, workspace: otherWorkspaceId });
  await mkMessage(x.id, { direction: "out", timestamp: D1, workspace: otherWorkspaceId });
});

afterAll(async () => {
  for (const ws of [workspaceId, otherWorkspaceId]) {
    await prisma.$transaction([
      prisma.aiMessageMetadata.deleteMany({ where: { workspaceId: ws } }),
      prisma.ticket.deleteMany({ where: { workspaceId: ws } }),
      prisma.message.deleteMany({ where: { workspaceId: ws } }),
      prisma.conversation.deleteMany({ where: { workspaceId: ws } }),
      prisma.contact.deleteMany({ where: { workspaceId: ws } }),
      prisma.workspaceMember.deleteMany({ where: { workspaceId: ws } }),
    ]);
    await prisma.workspace.delete({ where: { id: ws } });
  }
  await prisma.$disconnect();
});

describe("workspace performance report", () => {
  it("computes volumes, response times, agents, SLA and AI share — workspace-scoped", async () => {
    const r = await getWorkspaceReport(workspaceId, { from: FROM, to: TO, tz: "UTC" });

    // Volumes: A(1in/2out) + B(1in/2out) + C(1in/2out) = 3 in / 6 out.
    // Sibling workspace's 1/1 must not leak.
    expect(r.volume.inbound).toBe(3);
    expect(r.volume.outbound).toBe(6);
    expect(r.volume.conversationsOpened).toBe(4); // A,B,C + the ticket thread
    expect(r.volume.conversationsClosed).toBe(1);

    // Daily buckets: D1 day has A's 1in/2out; D2 day has B+C's 2in/4out.
    const d1 = r.volume.daily.find((d) => d.day === "2026-07-02");
    const d2 = r.volume.daily.find((d) => d.day === "2026-07-03");
    expect(d1).toEqual({ day: "2026-07-02", inbound: 1, outbound: 2 });
    expect(d2).toEqual({ day: "2026-07-03", inbound: 2, outbound: 4 });

    // First response: only A qualifies → avg = median = 600s.
    expect(r.firstResponse.answeredConversations).toBe(1);
    expect(r.firstResponse.avgSec).toBeCloseTo(600, 3);
    expect(r.firstResponse.medianSec).toBeCloseTo(600, 3);

    // Resolution: A closed D2 − created D1.
    expect(r.resolution.closedConversations).toBe(1);
    expect(r.resolution.medianSec).toBeCloseTo((D2.getTime() - D1.getTime()) / 1000, 3);

    // Agent row: 3 human sends (A×2 + C×1), 1 close, 1 first reply @600s.
    const agent = r.agents.find((a) => a.userId === agentId);
    expect(agent).toBeDefined();
    expect(agent!.name).toContain("Agent");
    expect(agent!.messagesSent).toBe(3);
    expect(agent!.conversationsClosed).toBe(1);
    expect(agent!.answeredConversations).toBe(1);
    expect(agent!.medianFirstResponseSec).toBeCloseTo(600, 3);

    // SLA: 2 tickets with a first-response SLA, 1 breached.
    expect(r.sla.ticketsCreated).toBe(2);
    expect(r.sla.firstResponse).toEqual({ withSla: 2, breached: 1 });

    // AI: 3 AI replies across B(2) + C(1); 2 conversations touched; only B is
    // AI-only (C got a human reply too).
    expect(r.ai.aiMessages).toBe(3);
    expect(r.ai.aiConversations).toBe(2);
    expect(r.ai.aiOnlyConversations).toBe(1);
  });

  it("daily buckets flip at the REQUESTED timezone's midnight, not UTC's", async () => {
    // 2026-07-03T15:00Z is already July 3 in Asia/Beirut (UTC+3) — but
    // 2026-07-02T10:00Z is July 2 in both. Ask in a zone where a UTC evening
    // crosses the date line: Pacific/Auckland (UTC+12) puts 15:00Z on July 4.
    const r = await getWorkspaceReport(workspaceId, {
      from: FROM,
      to: TO,
      tz: "Pacific/Auckland",
    });
    const jul4 = r.volume.daily.find((d) => d.day === "2026-07-04");
    expect(jul4?.inbound).toBe(2); // B+C's inbound at 15:00Z = 03:00 Jul 4 NZT
  });

  it("an empty range yields zeros and NULL durations (never fake 0s)", async () => {
    const r = await getWorkspaceReport(workspaceId, {
      from: new Date("2020-01-01T00:00:00Z"),
      to: new Date("2020-01-02T00:00:00Z"),
      tz: "UTC",
    });
    expect(r.volume.inbound).toBe(0);
    expect(r.firstResponse.medianSec).toBeNull();
    expect(r.resolution.avgSec).toBeNull();
    expect(r.agents).toEqual([]);
    expect(r.ai.aiOnlyConversations).toBe(0);
  });

  it("rejects an inverted range, an over-long range, and a junk timezone", async () => {
    await expect(
      getWorkspaceReport(workspaceId, { from: TO, to: FROM, tz: "UTC" }),
    ).rejects.toBeInstanceOf(ReportRangeError);
    await expect(
      getWorkspaceReport(workspaceId, {
        from: new Date("2020-01-01T00:00:00Z"),
        to: new Date("2022-01-01T00:00:00Z"),
        tz: "UTC",
      }),
    ).rejects.toBeInstanceOf(ReportRangeError);
    await expect(
      getWorkspaceReport(workspaceId, { from: FROM, to: TO, tz: "bad zone'; --" }),
    ).rejects.toBeInstanceOf(ReportRangeError);
  });
});
