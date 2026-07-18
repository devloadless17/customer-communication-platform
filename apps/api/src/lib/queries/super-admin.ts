import { db } from "@/lib/db";
import type {
  PlatformAnalytics,
  SuperAdminTeamDetail,
  SuperAdminTeamRow,
} from "@ccp/shared/dtos";
import type { TeamStatus } from "@ccp/shared/types";

// superAdmin: cross-team browsing. These queries are the ONLY ones that
// legitimately ignore the team scope — all callers must be gated through
// requireSuperAdmin in auth-helpers.

// DTO shapes live in @ccp/shared/dtos — single source for the wire shape.
export type { PlatformAnalytics, SuperAdminTeamDetail, SuperAdminTeamRow };

/**
 * Short-TTL memo for the two cross-team AGGREGATE reads below.
 *
 * WHY. Both walk every row a tenant owns. The roster's `_count.messages`
 * resolves to one index-only scan of `Message_teamId_timestamp_id_idx` per
 * team, so across N teams it scans the whole message index once;
 * `getPlatformAnalytics` then does the same again with an unfiltered
 * `message.count()`. At a 20M-message platform that is seconds of work
 * holding pool connections the customer-facing inbox and webhook ingest
 * share — and nothing stopped an admin from re-triggering it by refreshing.
 *
 * The reasoning in the comments below is about TEAM count staying low, which
 * is true and beside the point: the cliff is rows-per-team, and it is reached
 * by one large customer, not by many customers.
 *
 * A memo is the right fix rather than approximate counts (`reltuples`) —
 * these are displayed as exact figures on an admin dashboard, and silently
 * making them estimates is the kind of change nobody notices until they are
 * reconciling numbers. 60s of staleness on a platform overview is invisible;
 * the repeated full scans are not. Deliberately NOT applied to
 * `getTeamDetailForSuperAdmin` — that one is scoped to a single team and is
 * read right after an admin acts on it, where staleness would be confusing.
 */
const AGGREGATE_TTL_MS = 60_000;
const aggregateCache = new Map<string, { at: number; value: unknown }>();

async function memoAggregate<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = aggregateCache.get(key);
  if (hit && Date.now() - hit.at < AGGREGATE_TTL_MS) return hit.value as T;
  const value = await load();
  aggregateCache.set(key, { at: Date.now(), value });
  return value;
}

/** Drop the memo so the next read is fresh — called after a mutation that
 *  changes what these report (org approve / suspend / delete). */
export function invalidateSuperAdminAggregates(): void {
  aggregateCache.clear();
}

/**
 * Every team on the platform with aggregate counts. Built from one query
 * per aggregate — fine at low team-count (single-VPS pilot). At >100 teams
 * we'd swap to a single SQL query with LATERAL joins; not worth it yet.
 */
export async function listAllTeamsForSuperAdmin(): Promise<SuperAdminTeamRow[]> {
  return memoAggregate("roster", () => loadAllTeamsForSuperAdmin());
}

async function loadAllTeamsForSuperAdmin(): Promise<SuperAdminTeamRow[]> {
  const teams = await db.team.findMany({
    // createdAt-asc here; the platform page re-groups status-first (pending
    // queue on top) using this as the stable within-group order.
    orderBy: [{ createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      createdAt: true,
      status: true,
      statusReason: true,
      statusUpdatedAt: true,
      maxMembers: true,
      channelConnections: {
        where: { channel: "whatsapp" },
        select: { config: true },
      },
      _count: {
        select: {
          users: true,
          contacts: true,
          conversations: true,
          messages: true,
          broadcasts: true,
        },
      },
    },
  });
  return teams.map((t) => {
    const cfg = (t.channelConnections[0]?.config ?? {}) as {
      phoneNumberId?: string;
      displayPhoneNumber?: string;
    };
    return {
    id: t.id,
    name: t.name,
    createdAt: t.createdAt.toISOString(),
    status: t.status as TeamStatus,
    statusReason: t.statusReason,
    statusUpdatedAt: t.statusUpdatedAt?.toISOString() ?? null,
    whatsappConnected: Boolean(cfg.phoneNumberId),
    whatsappDisplayNumber: cfg.displayPhoneNumber ?? null,
    userCount: t._count.users,
    maxMembers: t.maxMembers,
    contactCount: t._count.contacts,
    conversationCount: t._count.conversations,
    messageCount: t._count.messages,
    broadcastCount: t._count.broadcasts,
    };
  });
}

export async function getTeamDetailForSuperAdmin(
  teamId: string,
): Promise<SuperAdminTeamDetail | null> {
  const team = await db.team.findUnique({
    where: { id: teamId },
    select: {
      id: true,
      name: true,
      createdAt: true,
      status: true,
      statusReason: true,
      statusUpdatedAt: true,
      maxMembers: true,
      channelConnections: {
        where: { channel: "whatsapp" },
        select: { config: true },
      },
      _count: {
        select: {
          users: true,
          contacts: true,
          conversations: true,
          messages: true,
          broadcasts: true,
        },
      },
    },
  });
  if (!team) return null;
  const waCfg = (team.channelConnections[0]?.config ?? {}) as {
    phoneNumberId?: string;
    displayPhoneNumber?: string;
  };

  // Members only. Conversations are intentionally NOT fetched here —
  // superAdmin's visibility ends at aggregate counts + the member roster,
  // never at message bodies or contact names. Customer chats stay private
  // to each team.
  const members = await db.user.findMany({
    where: { teamId },
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      deactivatedAt: true,
      createdAt: true,
    },
  });

  return {
    team: {
      id: team.id,
      name: team.name,
      createdAt: team.createdAt.toISOString(),
      status: team.status as TeamStatus,
      statusReason: team.statusReason,
      statusUpdatedAt: team.statusUpdatedAt?.toISOString() ?? null,
      maxMembers: team.maxMembers,
      whatsappConnected: Boolean(waCfg.phoneNumberId),
      whatsappDisplayNumber: waCfg.displayPhoneNumber ?? null,
      userCount: team._count.users,
      contactCount: team._count.contacts,
      conversationCount: team._count.conversations,
      messageCount: team._count.messages,
      broadcastCount: team._count.broadcasts,
    },
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      deactivatedAt: m.deactivatedAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

/**
 * Platform-wide aggregates for the super-admin Overview. Cross-team by design
 * (same "ignores team scope" category as the browse queries above) — counts
 * only, never customer content. A handful of cheap COUNT / groupBy queries;
 * fine at single-VPS pilot scale.
 */
export async function getPlatformAnalytics(): Promise<PlatformAnalytics> {
  return memoAggregate("analytics", () => loadPlatformAnalytics());
}

async function loadPlatformAnalytics(): Promise<PlatformAnalytics> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [byStatus, users, contacts, conversations, messages, broadcasts, newOrgsLast30d, pendingOrgs] =
    await Promise.all([
      db.team.groupBy({ by: ["status"], _count: { _all: true } }),
      db.user.count(),
      db.contact.count(),
      db.conversation.count(),
      db.message.count(),
      db.broadcast.count(),
      db.team.count({ where: { createdAt: { gte: since } } }),
      db.team.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { id: true, name: true, createdAt: true },
      }),
    ]);

  const countFor = (s: TeamStatus) =>
    byStatus.find((b) => b.status === s)?._count._all ?? 0;
  const pending = countFor("pending");
  const active = countFor("active");
  const suspended = countFor("suspended");

  return {
    orgs: { total: pending + active + suspended, pending, active, suspended },
    totals: { users, contacts, conversations, messages, broadcasts },
    newOrgsLast30d,
    pendingOrgs: pendingOrgs.map((t) => ({
      id: t.id,
      name: t.name,
      createdAt: t.createdAt.toISOString(),
    })),
  };
}
