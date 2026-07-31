/**
 * Team performance report — the per-agent aggregates behind /reports/team and
 * its /v1 parity routes (lib/analytics/team-report.ts), proven against a real
 * database:
 *
 *   - every current member appears (zero-activity + deactivated included);
 *     departed members keep their historical numbers under name: null;
 *   - messages sent excludes broadcast blasts; notes count per author;
 *   - conversations: assigned from the audit ledger, closed + resolution from
 *     the denormalized columns, FRT per first responder, open-now point-in-time;
 *   - calls: placed per initiator, answered + talk time per answerer, missed
 *     only in workspace totals;
 *   - tickets: created per creator, resolved + SLA breach flags per resolver,
 *     open-assigned point-in-time;
 *   - drill-down daily series sums to the same agent's table scalars;
 *   - the live snapshot counts open assigned chats + active calls;
 *   - tenant isolation: a sibling workspace's rows never leak in;
 *   - the retention sweeper deletes old rows but keeps `assigned` events (the
 *     permanent assignment ledger this report reads).
 *
 *   pnpm --filter @ccp/api exec vitest run test/reports-team.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { ReportRangeError } from "@/lib/analytics/reports";
import {
  getTeamAgentDetail,
  getTeamLiveSnapshot,
  getTeamReport,
} from "@/lib/analytics/team-report";
import { sweepConversationEventRetentionOnce } from "@/lib/sweepers/conversation-event-retention";
import { sampleAgentPresenceOnce } from "@/lib/sweepers/agent-presence-sample";
import { setOnlinePresenceEnumerator } from "@/lib/conversations/presence-bridge";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `tr${Date.now().toString().slice(-8)}`;

// A fixed window: 2026-07-01 .. 2026-07-08 UTC.
const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-07-08T00:00:00.000Z");
const D1 = new Date("2026-07-02T10:00:00.000Z");
const D2 = new Date("2026-07-03T15:00:00.000Z");

let workspaceId = "";
let otherWorkspaceId = "";
let agentId = ""; // active agent with activity
let idleId = ""; // deactivated member, zero activity
let goneId = ""; // departed (no membership) with historical activity
let seq = 0;

async function mkConversation(opts?: {
  createdAt?: Date;
  firstResponseAt?: Date;
  firstResponseByUserId?: string;
  closedAt?: Date;
  closedByUserId?: string;
  assignedUserId?: string;
  workspace?: string;
}) {
  seq += 1;
  const ws = opts?.workspace ?? workspaceId;
  const contact = await prisma.contact.create({
    data: {
      workspaceId: ws,
      name: `Tr ${S}-${seq}`,
      identityChannel: "whatsapp",
      phoneNumber: `9613${Date.now().toString().slice(-6)}${seq}`,
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
      ...(opts?.assignedUserId ? { assignedUserId: opts.assignedUserId } : {}),
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
    workspace?: string;
  },
) {
  seq += 1;
  return prisma.message.create({
    data: {
      workspaceId: opts.workspace ?? workspaceId,
      conversationId,
      channel: "whatsapp",
      externalId: `${S}_wamid_${seq}`,
      body: "x",
      direction: opts.direction,
      timestamp: opts.timestamp,
      ...(opts.senderUserId ? { senderUserId: opts.senderUserId } : {}),
      ...(opts.broadcastId ? { broadcastId: opts.broadcastId } : {}),
    },
    select: { id: true },
  });
}

async function mkAssignedEvent(
  conversationId: string,
  assignedUserId: string,
  at: Date,
  ws = workspaceId,
) {
  return prisma.conversationEvent.create({
    data: {
      workspaceId: ws,
      conversationId,
      kind: "assigned",
      after: { assignedUserId },
      at,
    },
  });
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Tr Org ${S}`, status: "active" },
  });
  workspaceId = (
    await prisma.workspace.create({
      data: { name: `Tr WS ${S}`, organizationId: org.id },
    })
  ).id;
  otherWorkspaceId = (
    await prisma.workspace.create({
      data: { name: `Tr WS2 ${S}`, organizationId: org.id },
    })
  ).id;

  const mkUser = async (name: string, deactivated = false) =>
    (
      await prisma.user.create({
        data: {
          organizationId: org.id,
          orgRole: "member",
          name: `${name} ${S}`,
          email: `${name.toLowerCase()}-${S}@example.test`,
          ...(deactivated ? { deactivatedAt: new Date() } : {}),
        },
        select: { id: true },
      })
    ).id;

  agentId = await mkUser("Agent");
  idleId = await mkUser("Idle", true);
  goneId = await mkUser("Gone"); // NO membership — departed
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId, userId: agentId, role: "agent" },
      { workspaceId, userId: idleId, role: "manager" },
    ],
  });

  // --- Thread A: answered + closed by agent. FRT 600s, resolution D2-D1.
  //     2 human sends + 1 broadcast blast (excluded), assigned twice.
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
  await mkMessage(a.id, {
    direction: "out",
    timestamp: new Date(D1.getTime() + 1_200_000),
    senderUserId: agentId,
    broadcastId: `${S}_bcast`, // plain column, no FK — a blast, not agent work
  });
  await mkAssignedEvent(a.id, agentId, D1);
  await mkAssignedEvent(a.id, agentId, D2);

  // --- Thread B: open, currently assigned to agent (openNow) + closed by the
  //     DEPARTED member inside the window (their history must survive).
  const b = await mkConversation({ createdAt: D1, assignedUserId: agentId });
  await mkMessage(b.id, { direction: "in", timestamp: D1 });
  const g = await mkConversation({
    createdAt: D1,
    closedAt: D2,
    closedByUserId: goneId,
  });
  await mkMessage(g.id, {
    direction: "out",
    timestamp: D1,
    senderUserId: goneId,
  });

  // --- Note by the agent, in window.
  await prisma.internalNote.create({
    data: {
      workspaceId,
      conversationId: b.id,
      authorUserId: agentId,
      body: "note",
      timestamp: D1,
    },
  });

  // --- Calls: an answered+completed call (120s talk), an outbound placed by
  //     the agent, a missed ring (workspace total only), and an in-progress
  //     call for the live snapshot.
  await prisma.call.createMany({
    data: [
      {
        workspaceId,
        conversationId: a.id,
        externalCallId: `${S}_call_1`,
        rawPayload: {},
        direction: "in" as const,
        status: "completed" as const,
        answeredByUserId: agentId,
        ringingAt: D1,
        answeredAt: new Date(D1.getTime() + 10_000),
        endedAt: new Date(D1.getTime() + 130_000),
        durationSeconds: 120,
      },
      {
        workspaceId,
        conversationId: a.id,
        externalCallId: `${S}_call_2`,
        rawPayload: {},
        direction: "out" as const,
        status: "completed" as const,
        initiatedByUserId: agentId,
        answeredByUserId: agentId,
        ringingAt: D2,
        answeredAt: new Date(D2.getTime() + 5_000),
        endedAt: new Date(D2.getTime() + 65_000),
        durationSeconds: 60,
      },
      {
        workspaceId,
        conversationId: b.id,
        externalCallId: `${S}_call_3`,
        rawPayload: {},
        direction: "in" as const,
        status: "missed" as const,
        ringingAt: D2,
      },
      {
        workspaceId,
        conversationId: b.id,
        externalCallId: `${S}_call_4`,
        rawPayload: {},
        direction: "in" as const,
        status: "in_progress" as const,
        answeredByUserId: agentId,
        ringingAt: D2,
        answeredAt: new Date(D2.getTime() + 3_000),
      },
    ],
  });

  // --- Tickets: created by agent; resolved by agent with BOTH breach flags;
  //     one open ticket currently assigned to the agent.
  await prisma.ticket.createMany({
    data: [
      {
        workspaceId,
        conversationId: a.id,
        channel: "whatsapp" as const,
        number: 880001,
        subject: `Tr created ${S}`,
        createdAt: D1,
        createdById: agentId,
      },
      {
        workspaceId,
        conversationId: a.id,
        channel: "whatsapp" as const,
        number: 880002,
        subject: `Tr resolved ${S}`,
        createdAt: D1,
        status: "solved" as const,
        resolvedAt: D2,
        resolvedById: agentId,
        firstResponseBreached: true,
        resolutionBreached: true,
      },
      {
        workspaceId,
        conversationId: b.id,
        channel: "whatsapp" as const,
        number: 880003,
        subject: `Tr open ${S}`,
        createdAt: D2,
        status: "open" as const,
        assignedUserId: agentId,
      },
    ],
  });

  // --- An explicit squad holding only the agent — the "By team" rollup.
  await prisma.team.create({
    data: {
      workspaceId,
      name: `Tr Squad ${S}`,
      includeAllMembers: false,
      members: { create: { workspaceId, userId: agentId } },
    },
  });

  // --- Presence ledger: 5h on D1's day + 2h on D2's day for the agent.
  await prisma.agentPresenceDaily.createMany({
    data: [
      { workspaceId, userId: agentId, date: new Date(Date.UTC(2026, 6, 2)), onlineMinutes: 300 },
      { workspaceId, userId: agentId, date: new Date(Date.UTC(2026, 6, 3)), onlineMinutes: 120 },
      // Outside the window — must not leak into the sum.
      { workspaceId, userId: agentId, date: new Date(Date.UTC(2026, 7, 1)), onlineMinutes: 999 },
    ],
  });

  // --- Sibling-workspace noise that must NOT appear in any aggregate.
  const x = await mkConversation({
    createdAt: D1,
    closedAt: D2,
    closedByUserId: agentId,
    workspace: otherWorkspaceId,
  });
  await mkMessage(x.id, {
    direction: "out",
    timestamp: D1,
    senderUserId: agentId,
    workspace: otherWorkspaceId,
  });
  await mkAssignedEvent(x.id, agentId, D1, otherWorkspaceId);
});

afterAll(async () => {
  for (const ws of [workspaceId, otherWorkspaceId]) {
    await prisma.$transaction([
      prisma.agentPresenceDaily.deleteMany({ where: { workspaceId: ws } }),
      prisma.teamMember.deleteMany({ where: { workspaceId: ws } }),
      prisma.team.deleteMany({ where: { workspaceId: ws } }),
      prisma.conversationEvent.deleteMany({ where: { workspaceId: ws } }),
      prisma.internalNote.deleteMany({ where: { workspaceId: ws } }),
      prisma.call.deleteMany({ where: { workspaceId: ws } }),
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

describe("team report", () => {
  it("aggregates every block per agent, roster-complete and workspace-scoped", async () => {
    const r = await getTeamReport(workspaceId, { from: FROM, to: TO, tz: "UTC" });

    const agent = r.agents.find((a) => a.userId === agentId);
    expect(agent).toBeDefined();
    expect(agent!.name).toContain("Agent");
    expect(agent!.role).toBe("agent");
    expect(agent!.deactivated).toBe(false);

    // Messages: 2 human sends; the broadcast blast is excluded. 1 note.
    expect(agent!.messages.sent).toBe(2);
    expect(agent!.messages.notesAuthored).toBe(1);

    // Conversations: 2 assignment events; 1 close (sibling workspace's close
    // by the same user must not leak); 1 open assigned now; FRT 600s.
    expect(agent!.conversations.assigned).toBe(2);
    expect(agent!.conversations.closed).toBe(1);
    expect(agent!.conversations.openNow).toBe(1);
    expect(agent!.conversations.firstReplies).toBe(1);
    expect(agent!.conversations.medianFirstResponseSec).toBeCloseTo(600, 3);
    expect(agent!.conversations.medianResolutionSec).toBeCloseTo(
      (D2.getTime() - D1.getTime()) / 1000,
      3,
    );

    // Calls: 1 placed; 3 answered (completed×2 + in-progress); talk time sums
    // only the stamped durations (120 + 60), so the average ignores the live
    // call too.
    expect(agent!.calls.placed).toBe(1);
    expect(agent!.calls.answered).toBe(3);
    expect(agent!.calls.talkTimeTotalSec).toBe(180);
    expect(agent!.calls.talkTimeAvgSec).toBeCloseTo(90, 3);

    // Tickets: 1 created by the agent, 1 resolved carrying both breach flags,
    // 1 open assigned now.
    expect(agent!.tickets.created).toBe(1);
    expect(agent!.tickets.resolved).toBe(1);
    expect(agent!.tickets.firstResponseBreached).toBe(1);
    expect(agent!.tickets.resolutionBreached).toBe(1);
    expect(agent!.tickets.openAssignedNow).toBe(1);

    // Roster completeness: the deactivated member appears with zeros; the
    // departed member appears under name: null with their historical close.
    const idle = r.agents.find((a) => a.userId === idleId);
    expect(idle).toBeDefined();
    expect(idle!.deactivated).toBe(true);
    expect(idle!.role).toBe("manager");
    expect(idle!.messages.sent).toBe(0);
    expect(idle!.conversations.medianFirstResponseSec).toBeNull();

    const gone = r.agents.find((a) => a.userId === goneId);
    expect(gone).toBeDefined();
    expect(gone!.name).toBeNull();
    expect(gone!.role).toBeNull();
    expect(gone!.conversations.closed).toBe(1);
    expect(gone!.messages.sent).toBe(1);

    // Totals: sums of the per-agent rows + the workspace-only missed count +
    // the workspace-level first-response block.
    expect(r.totals.messagesSent).toBe(3);
    expect(r.totals.conversationsClosed).toBe(2);
    expect(r.totals.conversationsAssigned).toBe(2);
    expect(r.totals.callsPlaced).toBe(1);
    expect(r.totals.callsAnswered).toBe(3);
    expect(r.totals.callsMissed).toBe(1);
    expect(r.totals.talkTimeTotalSec).toBe(180);
    expect(r.totals.ticketsCreated).toBe(1);
    expect(r.totals.ticketsResolved).toBe(1);
    expect(r.totals.notesAuthored).toBe(1);
    expect(r.totals.firstResponse.answeredConversations).toBe(1);
    expect(r.totals.firstResponse.medianSec).toBeCloseTo(600, 3);

    // Daily series: agent sends bucket on their UTC days, broadcast excluded.
    const d1 = r.daily.find((d) => d.day === "2026-07-02");
    expect(d1?.messagesSent).toBe(3); // A×2 + gone×1, all on D1's day
    const d2 = r.daily.find((d) => d.day === "2026-07-03");
    expect(d2?.conversationsClosed).toBe(2);

    // Online minutes: 300 + 120 inside the window; the out-of-window row and
    // the untracked members' null must both hold.
    expect(agent!.onlineMinutes).toBe(420);
    expect(idle!.onlineMinutes).toBeNull();
    expect(gone!.onlineMinutes).toBeNull();

    // Heatmap (UTC): both inbounds land at 2026-07-02T10:00Z — a Thursday.
    expect(r.heatmap).toEqual([{ dow: 4, hour: 10, inbound: 2 }]);

    // Team rollups: the explicit squad carries the agent's numbers; everyone
    // else (idle + gone) lands in the "No team" bucket with gone's history.
    const squad = r.teams.find((t) => t.teamId !== null);
    expect(squad?.name).toContain("Tr Squad");
    expect(squad?.memberCount).toBe(1);
    expect(squad?.assigned).toBe(2);
    expect(squad?.closed).toBe(1);
    expect(squad?.messagesSent).toBe(2);
    expect(squad?.callsAnswered).toBe(3);
    expect(squad?.talkTimeTotalSec).toBe(180);
    expect(squad?.ticketsResolved).toBe(1);
    const noTeam = r.teams.find((t) => t.teamId === null);
    expect(noTeam?.memberCount).toBe(2);
    expect(noTeam?.closed).toBe(1);
    expect(noTeam?.messagesSent).toBe(1);
  });

  it("presence sampler: no-op without an enumerator; increments today's ledger with one", async () => {
    const countBefore = await prisma.agentPresenceDaily.count({ where: { workspaceId } });
    // No enumerator wired in this test process → null → skip, write nothing.
    await sampleAgentPresenceOnce();
    expect(await prisma.agentPresenceDaily.count({ where: { workspaceId } })).toBe(
      countBefore,
    );

    // Wire one reporting the idle member online; two ticks accumulate 10min.
    setOnlinePresenceEnumerator(() => [{ workspaceId, userId: idleId }]);
    try {
      await sampleAgentPresenceOnce();
      await sampleAgentPresenceOnce();
    } finally {
      setOnlinePresenceEnumerator(() => []);
    }
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const row = await prisma.agentPresenceDaily.findUnique({
      where: {
        workspaceId_userId_date: { workspaceId, userId: idleId, date: today },
      },
    });
    expect(row?.onlineMinutes).toBe(10);
  });

  it("drill-down returns the same row plus a daily series that sums to it", async () => {
    const d = await getTeamAgentDetail(workspaceId, agentId, {
      from: FROM,
      to: TO,
      tz: "UTC",
    });
    expect(d).not.toBeNull();
    expect(d!.messages.sent).toBe(2);
    expect(d!.daily.reduce((n, x) => n + x.messagesSent, 0)).toBe(2);
    expect(d!.daily.reduce((n, x) => n + x.conversationsClosed, 0)).toBe(1);

    // Departed members with history still resolve (the sheet opens for
    // "Former member" rows too).
    const gone = await getTeamAgentDetail(workspaceId, goneId, {
      from: FROM,
      to: TO,
      tz: "UTC",
    });
    expect(gone).not.toBeNull();
    expect(gone!.name).toBeNull();

    // Unknown user: null (the route 404s).
    expect(
      await getTeamAgentDetail(workspaceId, "nope_missing", {
        from: FROM,
        to: TO,
        tz: "UTC",
      }),
    ).toBeNull();
  });

  it("live snapshot counts open assigned chats and active calls per agent", async () => {
    const live = await getTeamLiveSnapshot(workspaceId);
    const agent = live.agents.find((a) => a.userId === agentId);
    expect(agent).toBeDefined();
    expect(agent!.openAssigned).toBe(1); // thread B
    expect(agent!.activeCalls).toBe(1); // the in_progress call
  });

  it("rejects bad ranges and an accountId the workspace does not own", async () => {
    await expect(
      getTeamReport(workspaceId, { from: TO, to: FROM, tz: "UTC" }),
    ).rejects.toBeInstanceOf(ReportRangeError);
    await expect(
      getTeamReport(workspaceId, {
        from: FROM,
        to: TO,
        tz: "UTC",
        accountId: "not_ours",
      }),
    ).rejects.toBeInstanceOf(ReportRangeError);
  });

  it("retention sweep keeps `assigned` events (the report's ledger) while deleting old rows of other kinds", async () => {
    // Two ancient rows, both far past any retention window.
    const old = new Date("2020-01-01T00:00:00.000Z");
    const conv = await mkConversation({ createdAt: D1 });
    const keep = await mkAssignedEvent(conv.id, agentId, old);
    const drop = await prisma.conversationEvent.create({
      data: {
        workspaceId,
        conversationId: conv.id,
        kind: "status_changed",
        after: { status: "closed" },
        at: old,
      },
    });

    await sweepConversationEventRetentionOnce();

    expect(
      await prisma.conversationEvent.findUnique({ where: { id: keep.id } }),
    ).not.toBeNull();
    expect(
      await prisma.conversationEvent.findUnique({ where: { id: drop.id } }),
    ).toBeNull();
  });
});
