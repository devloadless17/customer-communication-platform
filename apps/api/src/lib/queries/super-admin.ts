import "server-only";

import { db } from "@/lib/db";
import type {
  SuperAdminTeamDetail,
  SuperAdminTeamRow,
} from "@ccp/shared/dtos";

// superAdmin: cross-team browsing. These queries are the ONLY ones that
// legitimately ignore the team scope — all callers must be gated through
// requireSuperAdmin in auth-helpers.

// DTO shapes live in @ccp/shared/dtos — single source for the wire shape.
export type { SuperAdminTeamDetail, SuperAdminTeamRow };

/**
 * Every team on the platform with aggregate counts. Built from one query
 * per aggregate — fine at low team-count (single-VPS pilot). At >100 teams
 * we'd swap to a single SQL query with LATERAL joins; not worth it yet.
 */
export async function listAllTeamsForSuperAdmin(): Promise<SuperAdminTeamRow[]> {
  const teams = await db.team.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      metaPhoneNumberId: true,
      metaDisplayPhoneNumber: true,
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
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    createdAt: t.createdAt.toISOString(),
    whatsappConnected: Boolean(t.metaPhoneNumberId),
    whatsappDisplayNumber: t.metaDisplayPhoneNumber ?? null,
    userCount: t._count.users,
    contactCount: t._count.contacts,
    conversationCount: t._count.conversations,
    messageCount: t._count.messages,
    broadcastCount: t._count.broadcasts,
  }));
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
      metaPhoneNumberId: true,
      metaDisplayPhoneNumber: true,
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
      whatsappConnected: Boolean(team.metaPhoneNumberId),
      whatsappDisplayNumber: team.metaDisplayPhoneNumber ?? null,
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
