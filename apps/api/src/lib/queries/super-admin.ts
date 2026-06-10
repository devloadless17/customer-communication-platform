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
 * Every team on the platform with aggregate counts. Built from one query
 * per aggregate — fine at low team-count (single-VPS pilot). At >100 teams
 * we'd swap to a single SQL query with LATERAL joins; not worth it yet.
 */
export async function listAllTeamsForSuperAdmin(): Promise<SuperAdminTeamRow[]> {
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
