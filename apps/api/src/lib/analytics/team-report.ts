import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import {
  conversationAccountWhere,
  messageAccountJoin,
  messageAccountWhere,
  queryFirstResponse,
  validateReportRange,
  type ReportRange,
} from "@/lib/analytics/reports";
import { withoutOperatorRows } from "@/lib/workspaces/operator-mask";
import { TICKET_ACTIVE_STATUSES } from "@ccp/shared/tickets/types";
import type { TicketStatus } from "@prisma/client";
import type {
  TeamLiveSnapshot,
  TeamReport,
  TeamReportAgent,
  TeamReportAgentDetail,
  TeamReportDaily,
  TeamReportTeamRollup,
} from "@ccp/shared/dtos";

/**
 * Team performance report — the per-agent aggregates behind /reports/team
 * (and its /v1 parity endpoints). One call returns the whole page: workspace
 * totals, the daily series, and every agent's row.
 *
 * Metric definitions (explicit, because a per-person number that can't be
 * explained breeds distrust faster than any other kind):
 *
 *   - messages.sent        — outbound Message rows authored in range
 *                            (senderUserId), broadcast blasts EXCLUDED. Same
 *                            predicate as the overview's agents panel, so the
 *                            two tabs can never disagree.
 *   - messages.notesAuthored — InternalNote rows in range.
 *   - conversations.assigned — assignment events TO the agent in range, from
 *                            the audit ledger (ConversationEvent
 *                            kind='assigned', assignee in `after`). These rows
 *                            are exempt from the retention sweeper — see
 *                            lib/sweepers/conversation-event-retention.ts —
 *                            so the count is complete for any allowed range.
 *   - conversations.closed / resolution — Conversation.closedByUserId over
 *                            closedAt in range (most recent close; a reopen
 *                            nulls it — the operationally honest reading, and
 *                            the overview's definition).
 *   - conversations.firstReplies / FRT — conversations CREATED in range the
 *                            agent answered first (firstResponseByUserId),
 *                            avg + median of firstResponseAt - createdAt.
 *   - conversations.openNow — point-in-time open chats currently assigned
 *                            (ignores the range; the "workload right now"
 *                            column).
 *   - calls                — placed = initiatedByUserId, answered =
 *                            answeredByUserId, both anchored on ringingAt in
 *                            range. Talk time sums durationSeconds (stamped at
 *                            the terminal transition, so an in-progress call
 *                            counts as answered but contributes no talk time
 *                            yet). Missed calls ring the TEAM, not one agent —
 *                            they appear only in `totals.callsMissed`.
 *   - tickets              — created = createdById on createdAt; resolved +
 *                            SLA breach flags = resolvedById on resolvedAt
 *                            (one attribution rule — the resolver — and one
 *                            time anchor); openAssignedNow = point-in-time
 *                            active-status tickets by assignee.
 *
 * `accountId` scope applies to message- and conversation-anchored metrics
 * exactly as the overview does (same exported helpers); Call, Ticket and
 * InternalNote carry no account column, so those blocks always cover the
 * whole workspace — documented on the DTO.
 *
 * All queries are workspace-scoped and range-bound. The Message aggregates
 * ride Message_teamId_timestamp_id_idx, calls ride the new
 * (workspaceId, ringingAt) index, assigned events the new
 * (workspaceId, kind, at) index; the rest are covered by existing composites.
 */

/** The five raw per-day series merged into TeamReportDaily client shape. */
interface DailyRow {
  day: string;
  count: number;
}

export async function getTeamReport(
  workspaceId: string,
  range: ReportRange,
): Promise<TeamReport> {
  const { from, to, tz, accountId } = range;
  await validateReportRange(workspaceId, range);

  const [agents, daily, callsMissed, firstResponse, heatmap, teamsRaw] =
    await Promise.all([
      queryTeamAgents(workspaceId, from, to, accountId),
      queryTeamDaily(workspaceId, from, to, tz, accountId),
      db.call.count({
        where: {
          workspaceId,
          status: "missed",
          ringingAt: { gte: from, lt: to },
        },
      }),
      // Workspace-level first response (medians don't sum, so the tile can't
      // be derived from the per-agent rows). Same query the overview runs —
      // the two tabs' headline numbers must be equal by construction.
      queryFirstResponse(workspaceId, from, to, accountId),
      queryHeatmap(workspaceId, from, to, tz, accountId),
      db.team.findMany({
        where: { workspaceId, archivedAt: null },
        select: {
          id: true,
          name: true,
          includeAllMembers: true,
          eligibleRoles: true,
          members: { select: { userId: true, enabled: true } },
        },
        orderBy: { name: "asc" },
      }),
    ]);

  const totals = agents.reduce(
    (acc, a) => {
      acc.messagesSent += a.messages.sent;
      acc.notesAuthored += a.messages.notesAuthored;
      acc.conversationsAssigned += a.conversations.assigned;
      acc.conversationsClosed += a.conversations.closed;
      acc.callsPlaced += a.calls.placed;
      acc.callsAnswered += a.calls.answered;
      acc.talkTimeTotalSec += a.calls.talkTimeTotalSec;
      acc.ticketsCreated += a.tickets.created;
      acc.ticketsResolved += a.tickets.resolved;
      return acc;
    },
    {
      messagesSent: 0,
      notesAuthored: 0,
      conversationsAssigned: 0,
      conversationsClosed: 0,
      callsPlaced: 0,
      callsAnswered: 0,
      callsMissed,
      talkTimeTotalSec: 0,
      ticketsCreated: 0,
      ticketsResolved: 0,
      firstResponse,
    },
  );

  return {
    range: {
      from: from.toISOString(),
      to: to.toISOString(),
      tz,
      accountId: accountId ?? null,
    },
    totals,
    daily,
    agents,
    heatmap,
    teams: buildTeamRollups(teamsRaw, agents),
  };
}

/**
 * Sum the per-agent rows over each assignment team's membership. Membership
 * follows the SAME rule the routing pool uses (lib/assignment/pool.ts):
 * `includeAllMembers` teams cover every roster member minus disabled
 * overrides; explicit squads are exactly their enabled member rows; a
 * non-empty `eligibleRoles` narrows either. A user on two teams counts in
 * both — that is what "team output" means. Members outside every team land in
 * a "No team" bucket; a workspace with no teams gets [] (the panel hides).
 */
function buildTeamRollups(
  teams: Array<{
    id: string;
    name: string;
    includeAllMembers: boolean;
    eligibleRoles: string[];
    members: Array<{ userId: string; enabled: boolean }>;
  }>,
  agents: TeamReportAgent[],
): TeamReportTeamRollup[] {
  if (teams.length === 0) return [];

  const rollup = (
    teamId: string | null,
    name: string,
    memberIds: Set<string>,
  ): TeamReportTeamRollup => {
    const acc: TeamReportTeamRollup = {
      teamId,
      name,
      memberCount: memberIds.size,
      assigned: 0,
      closed: 0,
      messagesSent: 0,
      callsAnswered: 0,
      talkTimeTotalSec: 0,
      ticketsResolved: 0,
    };
    for (const a of agents) {
      if (!memberIds.has(a.userId)) continue;
      acc.assigned += a.conversations.assigned;
      acc.closed += a.conversations.closed;
      acc.messagesSent += a.messages.sent;
      acc.callsAnswered += a.calls.answered;
      acc.talkTimeTotalSec += a.calls.talkTimeTotalSec;
      acc.ticketsResolved += a.tickets.resolved;
    }
    return acc;
  };

  // Current roster only — departed members have no current-team membership,
  // so their historical numbers land in "No team" rather than being guessed
  // onto a squad they may never have joined.
  const rosterIds = agents.filter((a) => a.role !== null).map((a) => a.userId);
  const roleById = new Map(agents.map((a) => [a.userId, a.role]));

  const inAnyTeam = new Set<string>();
  const out: TeamReportTeamRollup[] = [];
  for (const t of teams) {
    const overrideByUser = new Map(t.members.map((m) => [m.userId, m]));
    const memberIds = new Set(
      (t.includeAllMembers
        ? rosterIds.filter((id) => overrideByUser.get(id)?.enabled !== false)
        : t.members.filter((m) => m.enabled).map((m) => m.userId)
      ).filter(
        (id) =>
          t.eligibleRoles.length === 0 ||
          t.eligibleRoles.includes(roleById.get(id) ?? "agent"),
      ),
    );
    for (const id of memberIds) inAnyTeam.add(id);
    out.push(rollup(t.id, t.name, memberIds));
  }

  const unteamed = new Set(agents.map((a) => a.userId).filter((id) => !inAnyTeam.has(id)));
  if (unteamed.size > 0) out.push(rollup(null, "No team", unteamed));
  return out;
}

/**
 * One agent's row plus their own per-day series — the drill-down behind the
 * table's slide-over. Reuses the full per-agent aggregation (same cost class
 * as loading the page; parameterizing every query by user would be a second
 * copy of each predicate to keep in sync) and adds the user-filtered series.
 */
export async function getTeamAgentDetail(
  workspaceId: string,
  userId: string,
  range: ReportRange,
): Promise<TeamReportAgentDetail | null> {
  const { from, to, tz, accountId } = range;
  await validateReportRange(workspaceId, range);

  const [agents, daily] = await Promise.all([
    queryTeamAgents(workspaceId, from, to, accountId),
    queryTeamDaily(workspaceId, from, to, tz, accountId, userId),
  ]);

  const agent = agents.find((a) => a.userId === userId);
  if (!agent) return null;
  return { ...agent, daily };
}

/**
 * Point-in-time snapshot for the live "now" strip: open chats currently
 * assigned per agent, plus calls currently ringing/in progress attributed to
 * whoever answered (or, until someone does, whoever placed) them. Cheap
 * enough to re-poll on every assignment/status/call socket event.
 */
export async function getTeamLiveSnapshot(
  workspaceId: string,
): Promise<TeamLiveSnapshot> {
  const [openAssigned, activeCalls] = await Promise.all([
    db.conversation.groupBy({
      by: ["assignedUserId"],
      where: {
        workspaceId,
        assignedUserId: { not: null },
        status: { not: "closed" },
      },
      _count: { _all: true },
    }),
    db.$queryRaw<Array<{ user_id: string | null; count: number }>>(Prisma.sql`
      SELECT COALESCE("answeredByUserId", "initiatedByUserId") AS user_id,
             count(*)::int AS count
      FROM   "Call"
      WHERE  "workspaceId" = ${workspaceId}
        AND  status IN ('ringing', 'in_progress')
      GROUP  BY 1
    `),
  ]);

  const byUser = new Map<string, { openAssigned: number; activeCalls: number }>();
  const row = (userId: string) => {
    let r = byUser.get(userId);
    if (!r) {
      r = { openAssigned: 0, activeCalls: 0 };
      byUser.set(userId, r);
    }
    return r;
  };
  for (const r of openAssigned) {
    if (r.assignedUserId) row(r.assignedUserId).openAssigned = r._count._all;
  }
  for (const r of activeCalls) {
    if (r.user_id) row(r.user_id).activeCalls = r.count;
  }

  // OPERATOR EXCLUSION - same rule as the aggregate tables above
  // (`withoutOperatorRows`). An operator-initiated test call would otherwise
  // put an unnamed row in the live strip: the roster can't resolve them, so
  // the tenant sees activity attributed to nobody.
  const agents = await withoutOperatorRows(
    db,
    workspaceId,
    [...byUser.entries()].map(([userId, v]) => ({ userId, ...v })),
  );

  return {
    generatedAt: new Date().toISOString(),
    agents,
  };
}

/** The UTC day bucket an instant falls in — matches AgentPresenceDaily.date. */
function utcDay(instant: Date): Date {
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
}

/**
 * Inbound demand by (day-of-week, hour) in the CALLER's timezone — the
 * busiest-hours heatmap. Inbound only: staffing follows when customers write,
 * not when agents answer. Same tz conversion as the daily series.
 */
async function queryHeatmap(
  workspaceId: string,
  from: Date,
  to: Date,
  tz: string,
  accountId?: string,
): Promise<Array<{ dow: number; hour: number; inbound: number }>> {
  return db.$queryRaw<Array<{ dow: number; hour: number; inbound: number }>>(Prisma.sql`
    SELECT EXTRACT(dow  FROM ((m."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}))::int AS dow,
           EXTRACT(hour FROM ((m."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}))::int AS hour,
           count(*)::int AS inbound
    FROM   "Message" m
    ${messageAccountJoin(accountId)}
    WHERE  m."workspaceId" = ${workspaceId}
      AND  m."timestamp" >= ${from} AND m."timestamp" < ${to}
      AND  m.direction = 'in'
      ${messageAccountWhere(accountId)}
    GROUP  BY 1, 2
  `);
}

/**
 * The per-agent aggregation: independent per-actor aggregates (each anchored
 * on a different row/column, so one SQL join would multi-scan the tables)
 * FULL-OUTER-merged in JS onto the member roster. Departed members (aggregate
 * rows with no User match) keep their numbers under a null name rather than
 * vanishing from the totals — same rule as the overview's agents panel.
 */
async function queryTeamAgents(
  workspaceId: string,
  from: Date,
  to: Date,
  accountId?: string,
): Promise<TeamReportAgent[]> {
  const activeStatuses = TICKET_ACTIVE_STATUSES as TicketStatus[];
  const [
    roster,
    sent,
    notes,
    closed,
    frt,
    assigned,
    openNow,
    callsPlaced,
    callsAnswered,
    ticketsCreated,
    ticketsResolved,
    ticketsOpenNow,
    presence,
  ] = await Promise.all([
    db.user.findMany({
      where: { workspaceMemberships: { some: { workspaceId } } },
      select: {
        id: true,
        name: true,
        email: true,
        deactivatedAt: true,
        workspaceMemberships: {
          where: { workspaceId },
          select: { role: true },
          take: 1,
        },
      },
    }),
    db.$queryRaw<Array<{ user_id: string; sent: number }>>(Prisma.sql`
      SELECT m."senderUserId" AS user_id, count(*)::int AS sent
      FROM   "Message" m
      ${messageAccountJoin(accountId)}
      WHERE  m."workspaceId" = ${workspaceId}
        AND  m."timestamp" >= ${from} AND m."timestamp" < ${to}
        AND  m.direction = 'out'
        AND  m."senderUserId" IS NOT NULL
        AND  m."broadcastId" IS NULL
        ${messageAccountWhere(accountId)}
      GROUP  BY 1
    `),
    db.internalNote.groupBy({
      by: ["authorUserId"],
      where: {
        workspaceId,
        authorUserId: { not: null },
        timestamp: { gte: from, lt: to },
      },
      _count: { _all: true },
    }),
    db.$queryRaw<
      Array<{
        user_id: string;
        closed: number;
        avg_sec: number | null;
        median_sec: number | null;
      }>
    >(Prisma.sql`
      SELECT "closedByUserId" AS user_id,
             count(*)::int AS closed,
             avg(EXTRACT(EPOCH FROM ("closedAt" - "createdAt")))::float8 AS avg_sec,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM ("closedAt" - "createdAt"))
             )::float8 AS median_sec
      FROM   "Conversation"
      WHERE  "workspaceId" = ${workspaceId}
        AND  "closedAt" >= ${from} AND "closedAt" < ${to}
        AND  "closedByUserId" IS NOT NULL
        ${conversationAccountWhere(accountId)}
      GROUP  BY 1
    `),
    db.$queryRaw<
      Array<{
        user_id: string;
        answered: number;
        avg_sec: number | null;
        median_sec: number | null;
      }>
    >(Prisma.sql`
      SELECT "firstResponseByUserId" AS user_id,
             count(*)::int AS answered,
             avg(EXTRACT(EPOCH FROM ("firstResponseAt" - "createdAt")))::float8 AS avg_sec,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM ("firstResponseAt" - "createdAt"))
             )::float8 AS median_sec
      FROM   "Conversation"
      WHERE  "workspaceId" = ${workspaceId}
        AND  "createdAt" >= ${from} AND "createdAt" < ${to}
        AND  "firstResponseAt" IS NOT NULL
        AND  "firstResponseByUserId" IS NOT NULL
        ${conversationAccountWhere(accountId)}
      GROUP  BY 1
    `),
    // Assignment actions in window — the assignee lives in `after` JSON, which
    // Prisma groupBy can't key on. When scoping to an account, join to the
    // conversation's current pointer (same honest limitation as the overview's
    // conversation-anchored metrics: a moved thread counts where it is NOW).
    db.$queryRaw<Array<{ user_id: string | null; count: number }>>(Prisma.sql`
      SELECT e."after"->>'assignedUserId' AS user_id, count(*)::int AS count
      FROM   "ConversationEvent" e
      ${accountId ? Prisma.sql`JOIN "Conversation" c ON c.id = e."conversationId"` : Prisma.empty}
      WHERE  e."workspaceId" = ${workspaceId}
        AND  e.kind = 'assigned'::"ConversationEventKind"
        AND  e."at" >= ${from} AND e."at" < ${to}
        ${conversationAccountWhere(accountId, accountId ? "c" : "")}
      GROUP  BY 1
    `),
    db.conversation.groupBy({
      by: ["assignedUserId"],
      where: {
        workspaceId,
        assignedUserId: { not: null },
        status: { not: "closed" },
        ...(accountId ? { channelConnectionId: accountId } : {}),
      },
      _count: { _all: true },
    }),
    db.call.groupBy({
      by: ["initiatedByUserId"],
      where: {
        workspaceId,
        initiatedByUserId: { not: null },
        ringingAt: { gte: from, lt: to },
      },
      _count: { _all: true },
    }),
    db.call.groupBy({
      by: ["answeredByUserId"],
      where: {
        workspaceId,
        answeredByUserId: { not: null },
        ringingAt: { gte: from, lt: to },
      },
      _count: { _all: true },
      _sum: { durationSeconds: true },
      _avg: { durationSeconds: true },
    }),
    db.ticket.groupBy({
      by: ["createdById"],
      where: {
        workspaceId,
        createdById: { not: null },
        createdAt: { gte: from, lt: to },
      },
      _count: { _all: true },
    }),
    db.$queryRaw<
      Array<{
        user_id: string;
        resolved: number;
        fr_breached: number;
        res_breached: number;
      }>
    >(Prisma.sql`
      SELECT "resolvedById" AS user_id,
             count(*)::int AS resolved,
             count(*) FILTER (WHERE "firstResponseBreached")::int AS fr_breached,
             count(*) FILTER (WHERE "resolutionBreached")::int AS res_breached
      FROM   "Ticket"
      WHERE  "workspaceId" = ${workspaceId}
        AND  "resolvedAt" >= ${from} AND "resolvedAt" < ${to}
        AND  "resolvedById" IS NOT NULL
      GROUP  BY 1
    `),
    db.ticket.groupBy({
      by: ["assignedUserId"],
      where: {
        workspaceId,
        assignedUserId: { not: null },
        status: { in: activeStatuses },
      },
      _count: { _all: true },
    }),
    // Online minutes: the sampler's UTC-day ledger summed over the covered
    // days ([from, to) → inclusive day bounds; the sub-day edge is the
    // documented approximation). Agents with no rows keep null — "not
    // tracked" must not render as "0h online".
    db.agentPresenceDaily.groupBy({
      by: ["userId"],
      where: {
        workspaceId,
        date: { gte: utcDay(from), lte: utcDay(new Date(to.getTime() - 1)) },
      },
      _sum: { onlineMinutes: true },
    }),
  ]);

  const byId = new Map<string, TeamReportAgent>();
  const row = (userId: string): TeamReportAgent => {
    let r = byId.get(userId);
    if (!r) {
      r = {
        userId,
        name: null,
        email: null,
        role: null,
        deactivated: false,
        conversations: {
          assigned: 0,
          closed: 0,
          openNow: 0,
          firstReplies: 0,
          avgFirstResponseSec: null,
          medianFirstResponseSec: null,
          avgResolutionSec: null,
          medianResolutionSec: null,
        },
        messages: { sent: 0, notesAuthored: 0 },
        calls: { placed: 0, answered: 0, talkTimeTotalSec: 0, talkTimeAvgSec: null },
        tickets: {
          created: 0,
          resolved: 0,
          openAssignedNow: 0,
          firstResponseBreached: 0,
          resolutionBreached: 0,
        },
        onlineMinutes: null,
      };
      byId.set(userId, r);
    }
    return r;
  };

  // Roster first, so every current member appears even with zero activity.
  for (const u of roster) {
    const r = row(u.id);
    r.name = u.name;
    r.email = u.email;
    r.role = u.workspaceMemberships[0]?.role ?? "agent";
    r.deactivated = u.deactivatedAt != null;
  }

  for (const s of sent) row(s.user_id).messages.sent = s.sent;
  for (const n of notes) {
    if (n.authorUserId) row(n.authorUserId).messages.notesAuthored = n._count._all;
  }
  for (const c of closed) {
    const r = row(c.user_id);
    r.conversations.closed = c.closed;
    r.conversations.avgResolutionSec = c.avg_sec;
    r.conversations.medianResolutionSec = c.median_sec;
  }
  for (const f of frt) {
    const r = row(f.user_id);
    r.conversations.firstReplies = f.answered;
    r.conversations.avgFirstResponseSec = f.avg_sec;
    r.conversations.medianFirstResponseSec = f.median_sec;
  }
  for (const a of assigned) {
    if (a.user_id) row(a.user_id).conversations.assigned = a.count;
  }
  for (const o of openNow) {
    if (o.assignedUserId) row(o.assignedUserId).conversations.openNow = o._count._all;
  }
  for (const p of callsPlaced) {
    if (p.initiatedByUserId) row(p.initiatedByUserId).calls.placed = p._count._all;
  }
  for (const a of callsAnswered) {
    if (!a.answeredByUserId) continue;
    const r = row(a.answeredByUserId);
    r.calls.answered = a._count._all;
    r.calls.talkTimeTotalSec = a._sum.durationSeconds ?? 0;
    r.calls.talkTimeAvgSec = a._avg.durationSeconds;
  }
  for (const t of ticketsCreated) {
    if (t.createdById) row(t.createdById).tickets.created = t._count._all;
  }
  for (const t of ticketsResolved) {
    const r = row(t.user_id);
    r.tickets.resolved = t.resolved;
    r.tickets.firstResponseBreached = t.fr_breached;
    r.tickets.resolutionBreached = t.res_breached;
  }
  for (const t of ticketsOpenNow) {
    if (t.assignedUserId) row(t.assignedUserId).tickets.openAssignedNow = t._count._all;
  }
  for (const p of presence) {
    row(p.userId).onlineMinutes = p._sum.onlineMinutes ?? 0;
  }

  // OPERATOR EXCLUSION — shared with the overview's Agents panel
  // (lib/workspaces/operator-mask.ts), so the two tabs cannot disagree about
  // who the team is.
  return withoutOperatorRows(db, workspaceId, [...byId.values()]);
}

/**
 * Per-day series: agent-authored messages sent and conversations closed,
 * bucketed at the CALLER's midnight — the exact tz expression the overview's
 * queryDaily uses, so the two tabs can never disagree on bucket edges.
 * Optional `userId` narrows both series to one agent (the drill-down chart).
 */
async function queryTeamDaily(
  workspaceId: string,
  from: Date,
  to: Date,
  tz: string,
  accountId?: string,
  userId?: string,
): Promise<TeamReportDaily[]> {
  const [sentRows, closedRows] = await Promise.all([
    db.$queryRaw<DailyRow[]>(Prisma.sql`
      -- "timestamp" is a NAIVE timestamp storing UTC (Prisma DateTime). Attach
      -- UTC first, then convert — see reports.ts queryDaily.
      SELECT to_char(date_trunc('day', (m."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day,
             count(*)::int AS count
      FROM   "Message" m
      ${messageAccountJoin(accountId)}
      WHERE  m."workspaceId" = ${workspaceId}
        AND  m."timestamp" >= ${from} AND m."timestamp" < ${to}
        AND  m.direction = 'out'
        AND  m."senderUserId" IS NOT NULL
        AND  m."broadcastId" IS NULL
        ${userId ? Prisma.sql`AND m."senderUserId" = ${userId}` : Prisma.empty}
        ${messageAccountWhere(accountId)}
      GROUP  BY 1
      ORDER  BY 1
    `),
    db.$queryRaw<DailyRow[]>(Prisma.sql`
      SELECT to_char(date_trunc('day', ("closedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day,
             count(*)::int AS count
      FROM   "Conversation"
      WHERE  "workspaceId" = ${workspaceId}
        AND  "closedAt" >= ${from} AND "closedAt" < ${to}
        AND  "closedByUserId" IS NOT NULL
        ${userId ? Prisma.sql`AND "closedByUserId" = ${userId}` : Prisma.empty}
        ${conversationAccountWhere(accountId)}
      GROUP  BY 1
      ORDER  BY 1
    `),
  ]);

  const byDay = new Map<string, TeamReportDaily>();
  const bucket = (day: string): TeamReportDaily => {
    let b = byDay.get(day);
    if (!b) {
      b = { day, messagesSent: 0, conversationsClosed: 0 };
      byDay.set(day, b);
    }
    return b;
  };
  for (const r of sentRows) bucket(r.day).messagesSent = r.count;
  for (const r of closedRows) bucket(r.day).conversationsClosed = r.count;

  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}
