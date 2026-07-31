import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import type { WorkspaceReport } from "@ccp/shared/dtos";

/**
 * Workspace performance report — the aggregates behind the /reports dashboard
 * (and its /v1 parity endpoint). One call returns every panel's data so the
 * page is a single round-trip.
 *
 * Metric definitions (deliberately explicit — a dashboard whose numbers can't
 * be explained breeds distrust):
 *
 *   - volume.daily        — Message rows in [from, to) bucketed per day in the
 *                           CALLER's timezone (daily bars must flip at the
 *                           workspace's midnight, not UTC's).
 *   - conversationsOpened — Conversation.createdAt in range.
 *   - conversationsClosed — Conversation.closedAt in range. `closedAt` refers
 *                           to the MOST RECENT close (reopen nulls it), which
 *                           is the operationally honest reading.
 *   - firstResponse       — over conversations CREATED in range that have a
 *                           first outbound (`firstResponseAt`, maintained by
 *                           lib/conversations/analytics.ts). Avg + median, so
 *                           one all-nighter outlier can't paint the team slow.
 *   - resolution          — closedAt - createdAt over conversations closed in
 *                           range.
 *   - agents              — messages sent (outbound with a senderUserId,
 *                           broadcast blasts excluded), conversations closed
 *                           (closedByUserId), and each agent's own median
 *                           first-response over conversations they answered
 *                           first.
 *   - sla                 — tickets created in range: how many carried an SLA
 *                           due date and how many breached it (breach flags
 *                           are stamped by the ticket-sla-breach sweeper).
 *   - ai                  — outbound messages carrying aiGenerated metadata;
 *                           `aiOnlyConversations` = threads whose EVERY
 *                           outbound in range was AI (broadcasts excluded) —
 *                           the honest "handled without a human" number.
 *
 * All queries are workspace-scoped and range-bound; the heavy ones ride
 * Message_teamId_timestamp_id_idx (workspaceId, timestamp) so a year-long
 * range on the busiest workspace is an index range scan, not a table scan.
 */

const MAX_RANGE_DAYS = 366;

export class ReportRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportRangeError";
  }
}

export interface ReportRange {
  from: Date;
  to: Date;
  /** IANA timezone for daily bucketing (validated against pg_timezone_names
   *  by Postgres itself — an invalid name errors rather than mis-bucketing). */
  tz: string;
  /**
   * Scope EVERY panel to ONE of the workspace's channel accounts — a specific
   * WhatsApp number, Page or Instagram handle.
   *
   * "How is the business doing" is the wrong question for a workspace running a
   * Sales and a Support line; they are separate operations sharing a medium,
   * and a blended first-response time hides one drowning behind the other.
   *
   * Omitted = the whole workspace, and the SQL is then byte-identical to what
   * it was before this existed (the account joins are emitted only when
   * filtering), so the unfiltered report costs nothing.
   */
  accountId?: string;
}

/**
 * Shared gate for every ranged report (overview + team). Rejects inverted /
 * oversized ranges and junk timezones with a legible `ReportRangeError`, and
 * verifies a requested `accountId` belongs to THIS workspace.
 *
 * TENANT SCOPE. `accountId` arrives from a query string, so it is validated
 * against the workspace before it reaches any raw SQL predicate. Every query
 * also carries `workspaceId` independently, so a foreign id could only ever
 * have matched nothing — but an unknown id silently returning an empty report
 * reads as "the Sales line did nothing", which is worse than an error.
 */
export async function validateReportRange(
  workspaceId: string,
  range: ReportRange,
): Promise<void> {
  const { from, to, tz, accountId } = range;
  if (!(from < to)) throw new ReportRangeError("`from` must be before `to`");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    throw new ReportRangeError(`range is capped at ${MAX_RANGE_DAYS} days`);
  }
  // Defense-in-depth: tz reaches SQL as a bound parameter (never interpolated),
  // and Postgres rejects unknown zone names — but reject junk early with a
  // legible error instead of a 500 from `AT TIME ZONE`.
  if (!/^[A-Za-z0-9_+/-]{1,64}$/.test(tz)) {
    throw new ReportRangeError("invalid timezone");
  }
  if (accountId) {
    const owned = await db.channelConnection.findFirst({
      where: { id: accountId, workspaceId },
      select: { id: true },
    });
    if (!owned) throw new ReportRangeError("unknown channel account");
  }
}

export async function getWorkspaceReport(
  workspaceId: string,
  range: ReportRange,
): Promise<WorkspaceReport> {
  const { from, to, tz, accountId } = range;
  await validateReportRange(workspaceId, range);

  const [daily, channels, accounts, convCounts, firstResponse, resolution, agents, sla, ai, aiOnly] =
    await Promise.all([
      queryDaily(workspaceId, from, to, tz, accountId),
      queryChannels(workspaceId, from, to, accountId),
      queryAccounts(workspaceId, from, to, accountId),
      queryConversationCounts(workspaceId, from, to, accountId),
      queryFirstResponse(workspaceId, from, to, accountId),
      queryResolution(workspaceId, from, to, accountId),
      queryAgents(workspaceId, from, to, accountId),
      querySla(workspaceId, from, to, accountId),
      queryAi(workspaceId, from, to, accountId),
      queryAiOnly(workspaceId, from, to, accountId),
    ]);

  return {
    range: {
      from: from.toISOString(),
      to: to.toISOString(),
      tz,
      // Echoed back so a client can tell a scoped report from a workspace-wide
      // one without tracking what it asked for.
      accountId: accountId ?? null,
    },
    volume: {
      inbound: daily.reduce((n, d) => n + d.inbound, 0),
      outbound: daily.reduce((n, d) => n + d.outbound, 0),
      conversationsOpened: convCounts.opened,
      conversationsClosed: convCounts.closed,
      daily,
    },
    channels,
    accounts,
    firstResponse,
    resolution,
    agents,
    sla,
    ai: { ...ai, aiOnlyConversations: aiOnly },
  };
}

/**
 * Narrow a MESSAGE-anchored query to one account.
 *
 * Uses the same COALESCE as the accounts breakdown, deliberately: filtering to
 * account B must reproduce exactly B's row in that panel. If the filter read
 * only `Message.channelConnectionId` while the panel coalesced, every
 * pre-column message would count in the breakdown and vanish under the filter —
 * the two halves of one screen disagreeing.
 *
 * The join is emitted ONLY when filtering, so an unfiltered report runs the
 * exact plan it ran before this existed.
 *
 * Exported for lib/analytics/team-report.ts — the team report's message
 * aggregates must scope identically or the two report tabs disagree.
 */
export function messageAccountJoin(accountId: string | undefined) {
  return accountId
    ? Prisma.sql`JOIN "Conversation" c ON c.id = m."conversationId"`
    : Prisma.empty;
}
export function messageAccountWhere(accountId: string | undefined) {
  return accountId
    ? Prisma.sql`AND COALESCE(m."channelConnectionId", c."channelConnectionId") = ${accountId}`
    : Prisma.empty;
}

/**
 * Narrow a CONVERSATION-anchored query (first response, resolution, closes) to
 * one account.
 *
 * Honest limitation, stated once here rather than repeated: a conversation has
 * ONE account pointer and ingest re-stamps it when the customer messages a
 * different number of ours. So a thread that moved is counted under the number
 * it belongs to NOW, not the one it was on when the clock started. There is no
 * better answer available — the metric is a property of the thread, and the
 * thread has a single current owner.
 */
export function conversationAccountWhere(accountId: string | undefined, alias = "") {
  const col = alias ? Prisma.raw(`${alias}."channelConnectionId"`) : Prisma.raw(`"channelConnectionId"`);
  return accountId ? Prisma.sql`AND ${col} = ${accountId}` : Prisma.empty;
}

async function queryDaily(
  workspaceId: string,
  from: Date,
  to: Date,
  tz: string,
  accountId?: string,
) {
  const rows = await db.$queryRaw<
    Array<{ day: string; inbound: number; outbound: number }>
  >(Prisma.sql`
    -- "timestamp" is a NAIVE timestamp storing UTC (Prisma DateTime). A single
    -- AT TIME ZONE would INTERPRET it as tz-local; attach UTC first, then
    -- convert — caught by the Pacific/Auckland spec before it shipped.
    SELECT to_char(date_trunc('day', (m."timestamp" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS day,
           count(*) FILTER (WHERE m.direction = 'in')::int  AS inbound,
           count(*) FILTER (WHERE m.direction = 'out')::int AS outbound
    FROM   "Message" m
    ${messageAccountJoin(accountId)}
    WHERE  m."workspaceId" = ${workspaceId}
      AND  m."timestamp" >= ${from} AND m."timestamp" < ${to}
      ${messageAccountWhere(accountId)}
    GROUP  BY 1
    ORDER  BY 1
  `);
  return rows;
}

async function queryChannels(workspaceId: string, from: Date, to: Date, accountId?: string) {
  const rows = await db.$queryRaw<
    Array<{ channel: string; inbound: number; outbound: number }>
  >(Prisma.sql`
    SELECT m.channel::text AS channel,
           count(*) FILTER (WHERE m.direction = 'in')::int  AS inbound,
           count(*) FILTER (WHERE m.direction = 'out')::int AS outbound
    FROM   "Message" m
    ${messageAccountJoin(accountId)}
    WHERE  m."workspaceId" = ${workspaceId}
      AND  m."timestamp" >= ${from} AND m."timestamp" < ${to}
      ${messageAccountWhere(accountId)}
    GROUP  BY 1
    ORDER  BY (count(*)) DESC
  `);
  return rows;
}

/**
 * Volume per ACCOUNT — which of the workspace's numbers/Pages did the work.
 *
 * The channel breakdown above answers "how much WhatsApp"; on a workspace
 * running a Sales and a Support number that is the wrong grain, because the two
 * are separate businesses sharing a medium. This is the question an operator
 * actually asks ("is the Support line drowning?") and it was unanswerable.
 *
 * COALESCE, deliberately. `Message.channelConnectionId` is the immutable record
 * of which account carried a message, but it is only populated from the day it
 * shipped — older rows are NULL by design (backfilling them from the
 * conversation's CURRENT pointer would have invented history). Falling back to
 * that pointer here is the best available answer for old rows and the exact
 * answer for new ones, so a report spanning the boundary stays readable instead
 * of lumping months into "unattributed".
 *
 * Rows with no account at all (a disconnected number's `onDelete: SetNull`
 * fallout) are returned with `accountId: null` rather than dropped — a report
 * that silently omits traffic is worse than one that labels it unattributed.
 */
async function queryAccounts(workspaceId: string, from: Date, to: Date, accountId?: string) {
  const rows = await db.$queryRaw<
    Array<{
      accountId: string | null;
      channel: string;
      name: string | null;
      inbound: number;
      outbound: number;
    }>
  >(Prisma.sql`
    SELECT COALESCE(m."channelConnectionId", c."channelConnectionId") AS "accountId",
           m.channel::text                                           AS channel,
           COALESCE(cc.label, cc."externalAccountId")                 AS name,
           count(*) FILTER (WHERE m.direction = 'in')::int            AS inbound,
           count(*) FILTER (WHERE m.direction = 'out')::int           AS outbound
    FROM   "Message" m
    JOIN   "Conversation" c ON c.id = m."conversationId"
    LEFT   JOIN "ChannelConnection" cc
           ON cc.id = COALESCE(m."channelConnectionId", c."channelConnectionId")
    WHERE  m."workspaceId" = ${workspaceId}
      AND  m."timestamp" >= ${from} AND m."timestamp" < ${to}
      ${messageAccountWhere(accountId)}
    GROUP  BY 1, 2, 3
    ORDER  BY (count(*)) DESC
  `);
  return rows;
}

async function queryConversationCounts(
  workspaceId: string,
  from: Date,
  to: Date,
  accountId?: string,
) {
  const account = accountId ? { channelConnectionId: accountId } : {};
  const [opened, closed] = await Promise.all([
    db.conversation.count({
      where: { workspaceId, createdAt: { gte: from, lt: to }, ...account },
    }),
    db.conversation.count({
      where: { workspaceId, closedAt: { gte: from, lt: to }, ...account },
    }),
  ]);
  return { opened, closed };
}

/** Exported for lib/analytics/team-report.ts — the team page's headline
 *  first-response tile must equal the overview's, not a re-derivation. */
export async function queryFirstResponse(workspaceId: string, from: Date, to: Date, accountId?: string) {
  const rows = await db.$queryRaw<
    Array<{ answered: number; avg_sec: number | null; median_sec: number | null }>
  >(Prisma.sql`
    SELECT count(*)::int AS answered,
           avg(EXTRACT(EPOCH FROM ("firstResponseAt" - "createdAt")))::float8 AS avg_sec,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM ("firstResponseAt" - "createdAt"))
           )::float8 AS median_sec
    FROM   "Conversation"
    WHERE  "workspaceId" = ${workspaceId}
      AND  "createdAt" >= ${from} AND "createdAt" < ${to}
      AND  "firstResponseAt" IS NOT NULL
      ${conversationAccountWhere(accountId)}
  `);
  const row = rows[0];
  return {
    answeredConversations: row?.answered ?? 0,
    avgSec: row?.avg_sec ?? null,
    medianSec: row?.median_sec ?? null,
  };
}

async function queryResolution(workspaceId: string, from: Date, to: Date, accountId?: string) {
  const rows = await db.$queryRaw<
    Array<{ closed: number; avg_sec: number | null; median_sec: number | null }>
  >(Prisma.sql`
    SELECT count(*)::int AS closed,
           avg(EXTRACT(EPOCH FROM ("closedAt" - "createdAt")))::float8 AS avg_sec,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM ("closedAt" - "createdAt"))
           )::float8 AS median_sec
    FROM   "Conversation"
    WHERE  "workspaceId" = ${workspaceId}
      AND  "closedAt" >= ${from} AND "closedAt" < ${to}
      ${conversationAccountWhere(accountId)}
  `);
  const row = rows[0];
  return {
    closedConversations: row?.closed ?? 0,
    avgSec: row?.avg_sec ?? null,
    medianSec: row?.median_sec ?? null,
  };
}

async function queryAgents(workspaceId: string, from: Date, to: Date, accountId?: string) {
  // Three independent per-agent aggregates FULL-OUTER-merged in JS (each has a
  // different anchor row/column, so one SQL join would triple-scan Message).
  const [sent, closed, frt, users] = await Promise.all([
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
    db.$queryRaw<Array<{ user_id: string; closed: number }>>(Prisma.sql`
      SELECT "closedByUserId" AS user_id, count(*)::int AS closed
      FROM   "Conversation"
      WHERE  "workspaceId" = ${workspaceId}
        AND  "closedAt" >= ${from} AND "closedAt" < ${to}
        AND  "closedByUserId" IS NOT NULL
        ${conversationAccountWhere(accountId)}
      GROUP  BY 1
    `),
    db.$queryRaw<
      Array<{ user_id: string; answered: number; median_sec: number | null }>
    >(Prisma.sql`
      SELECT "firstResponseByUserId" AS user_id,
             count(*)::int AS answered,
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
    db.user.findMany({
      where: { workspaceMemberships: { some: { workspaceId } } },
      select: { id: true, name: true },
    }),
  ]);

  const byId = new Map<
    string,
    { userId: string; messagesSent: number; conversationsClosed: number; answeredConversations: number; medianFirstResponseSec: number | null }
  >();
  const row = (userId: string) => {
    let r = byId.get(userId);
    if (!r) {
      r = {
        userId,
        messagesSent: 0,
        conversationsClosed: 0,
        answeredConversations: 0,
        medianFirstResponseSec: null,
      };
      byId.set(userId, r);
    }
    return r;
  };
  for (const s of sent) row(s.user_id).messagesSent = s.sent;
  for (const c of closed) row(c.user_id).conversationsClosed = c.closed;
  for (const f of frt) {
    const r = row(f.user_id);
    r.answeredConversations = f.answered;
    r.medianFirstResponseSec = f.median_sec;
  }

  // Names resolved at read time; a departed member (no User row match) keeps
  // the aggregate under a null name rather than vanishing from the totals.
  const nameById = new Map(users.map((u) => [u.id, u.name]));
  return [...byId.values()]
    .map((r) => ({ ...r, name: nameById.get(r.userId) ?? null }))
    .sort((a, b) => b.messagesSent - a.messagesSent);
}

async function querySla(workspaceId: string, from: Date, to: Date, accountId?: string) {
  const rows = await db.$queryRaw<
    Array<{
      total: number;
      with_fr: number;
      fr_breached: number;
      with_res: number;
      res_breached: number;
    }>
  >(Prisma.sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE t."firstResponseDueAt" IS NOT NULL)::int AS with_fr,
           count(*) FILTER (WHERE t."firstResponseBreached")::int          AS fr_breached,
           count(*) FILTER (WHERE t."resolutionDueAt" IS NOT NULL)::int    AS with_res,
           count(*) FILTER (WHERE t."resolutionBreached")::int             AS res_breached
    FROM   "Ticket" t
    WHERE  t."workspaceId" = ${workspaceId}
      AND  t."createdAt" >= ${from} AND t."createdAt" < ${to}
      ${
        accountId
          ? // Through the conversation — Ticket deliberately carries no account
            // column (it would drift, since the pointer re-stamps). EXISTS
            // rather than a join because `Ticket.conversationId` is nullable,
            // and an escalation twin with no thread must simply not match.
            Prisma.sql`AND EXISTS (
              SELECT 1 FROM "Conversation" tc
              WHERE tc.id = t."conversationId"
                AND tc."channelConnectionId" = ${accountId}
            )`
          : Prisma.empty
      }
  `);
  const row = rows[0];
  return {
    ticketsCreated: row?.total ?? 0,
    firstResponse: { withSla: row?.with_fr ?? 0, breached: row?.fr_breached ?? 0 },
    resolution: { withSla: row?.with_res ?? 0, breached: row?.res_breached ?? 0 },
  };
}

async function queryAi(workspaceId: string, from: Date, to: Date, accountId?: string) {
  const rows = await db.$queryRaw<
    Array<{ ai_messages: number; ai_conversations: number }>
  >(Prisma.sql`
    SELECT count(*)::int AS ai_messages,
           count(DISTINCT m."conversationId")::int AS ai_conversations
    FROM   "AiMessageMetadata" a
    JOIN   "Message" m ON m.id = a."messageId"
    ${messageAccountJoin(accountId)}
    WHERE  a."workspaceId" = ${workspaceId}
      AND  a."aiGenerated"
      AND  m.direction = 'out'
      AND  m."timestamp" >= ${from} AND m."timestamp" < ${to}
      ${messageAccountWhere(accountId)}
  `);
  const row = rows[0];
  return {
    aiMessages: row?.ai_messages ?? 0,
    aiConversations: row?.ai_conversations ?? 0,
  };
}

/** Threads whose EVERY outbound in range was AI-generated (broadcasts
 *  excluded) — "handled without a human touching it". */
async function queryAiOnly(workspaceId: string, from: Date, to: Date, accountId?: string) {
  const rows = await db.$queryRaw<Array<{ ai_only: number }>>(Prisma.sql`
    SELECT count(*)::int AS ai_only
    FROM (
      SELECT m."conversationId"
      FROM   "Message" m
      LEFT JOIN "AiMessageMetadata" a ON a."messageId" = m.id
      ${messageAccountJoin(accountId)}
      WHERE  m."workspaceId" = ${workspaceId}
        AND  m."timestamp" >= ${from} AND m."timestamp" < ${to}
        AND  m.direction = 'out'
        AND  m."broadcastId" IS NULL
        ${messageAccountWhere(accountId)}
      GROUP  BY 1
      HAVING bool_and(COALESCE(a."aiGenerated", false))
    ) t
  `);
  return rows[0]?.ai_only ?? 0;
}
