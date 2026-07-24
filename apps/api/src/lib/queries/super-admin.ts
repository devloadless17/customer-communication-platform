import { db } from "@/lib/db";
import type {
  PlatformAnalytics,
  SuperAdminTeamDetail,
  SuperAdminTeamRow,
  SuperAdminOrgRow,
} from "@ccp/shared/dtos";
import type { OrgRole, OrgStatus } from "@ccp/shared/types";

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
/**
 * Bumped by every invalidation. A load that STARTED before the bump must not
 * write its result, because that result was snapshotted before the mutation
 * the invalidation is announcing.
 *
 * Without this, `clear()` landing mid-load was silently undone by the very
 * load it meant to discard — and worse, the stale value got re-stamped with a
 * fresh `at`, buying it a full TTL. The concrete failure: an admin refreshes
 * the platform page, the roster load takes a couple of seconds (it walks
 * `_count.messages` per team), a new org registers during that window, and the
 * approval queue then hides that org for the next 60 seconds no matter how
 * many times they refresh — the exact symptom the invalidation exists to
 * prevent.
 */
let aggregateEpoch = 0;

async function memoAggregate<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = aggregateCache.get(key);
  if (hit && Date.now() - hit.at < AGGREGATE_TTL_MS) return hit.value as T;
  const startedAt = aggregateEpoch;
  const value = await load();
  // Only cache when nothing invalidated while we were loading. The caller
  // still gets this value — it is the freshest read we have — it just doesn't
  // get to poison the cache for the next 60s.
  if (startedAt === aggregateEpoch) {
    aggregateCache.set(key, { at: Date.now(), value });
  }
  return value;
}

/** Drop the memo so the next read is fresh — called after a mutation that
 *  changes what these report (org approve / suspend / delete / register). */
export function invalidateSuperAdminAggregates(): void {
  aggregateEpoch += 1;
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
  const teams = await db.workspace.findMany({
    // createdAt-asc here; the platform page re-groups status-first (pending
    // queue on top) using this as the stable within-group order.
    orderBy: [{ createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      createdAt: true,
      organizationId: true,
      // Seat cap is per-WORKSPACE; the workspace cap is per-ORGANISATION.
      maxMembers: true,
      organization: {
        select: {
          status: true,
          statusReason: true,
          statusUpdatedAt: true,
          maxWorkspaces: true,
          // Sibling count, so the platform page can render "N / max workspaces"
          // next to the cap it is editing.
          _count: { select: { workspaces: true } },
        },
      },
      channelConnections: {
        where: { channel: "whatsapp" },
        select: { config: true },
      },
      _count: {
        select: {
          // `Workspace.users` became `members` in the workspace rename. Prisma
          // select/_count fields are NOT typechecked, so this compiled clean and
          // only failed at request time with a 400 invalid_request.
          members: true,
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
    organizationId: t.organizationId,
    status: t.organization.status as OrgStatus,
    statusReason: t.organization.statusReason,
    statusUpdatedAt: t.organization.statusUpdatedAt?.toISOString() ?? null,
    whatsappConnected: Boolean(cfg.phoneNumberId),
    whatsappDisplayNumber: cfg.displayPhoneNumber ?? null,
    userCount: t._count.members,
    maxMembers: t.maxMembers,
    maxWorkspaces: t.organization.maxWorkspaces,
    contactCount: t._count.contacts,
    conversationCount: t._count.conversations,
    messageCount: t._count.messages,
    broadcastCount: t._count.broadcasts,
    };
  });
}

/**
 * Every ORGANISATION on the platform, each with the workspaces it owns.
 *
 * Org-first, because that is the unit the platform administers: approval
 * status, the workspace cap and the commercial relationship all sit on the
 * organisation. The previous version listed WORKSPACES under an
 * "Organizations" heading — it showed workspace ids and made one customer with
 * two workspaces look like two customers.
 *
 * Member counts are DISTINCT PEOPLE across the org's workspaces: someone who
 * belongs to two workspaces is one human being, and summing per-workspace
 * counts would double-count them.
 */
export async function listAllOrgsForSuperAdmin(): Promise<SuperAdminOrgRow[]> {
  return memoAggregate("org-roster", () => loadAllOrgsForSuperAdmin());
}

async function loadAllOrgsForSuperAdmin(): Promise<SuperAdminOrgRow[]> {
  const [orgs, workspaces] = await Promise.all([
    db.organization.findMany({
      // The platform's own anchor org is not a customer — see
      // `Organization.isPlatform`. Without this filter the operator's anchor
      // listed as a tenant called "Loadless" beside real customers, with its
      // own workspace indented under it.
      where: { isPlatform: false },
      orderBy: [{ createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        createdAt: true,
        status: true,
        statusReason: true,
        statusUpdatedAt: true,
        maxWorkspaces: true,
      },
    }),
    loadAllTeamsForSuperAdmin(),
  ]);

  // Distinct people per org, EXCLUDING platform operators and deactivated
  // accounts. Deliberately a groupBy rather than `_count: { users: true }`:
  // `_count` cannot take a filter, so it would silently include super admins
  // and disabled users — inflating "how big is this customer" with people who
  // hold no seat. One grouped query, not one per org.
  const seatRows = await db.user.groupBy({
    by: ["organizationId"],
    where: { isSuperAdmin: false, deactivatedAt: null },
    _count: { _all: true },
  });
  const seatsByOrg = new Map(
    seatRows.map((r) => [r.organizationId, r._count._all]),
  );

  const byOrg = new Map<string, SuperAdminTeamRow[]>();
  for (const ws of workspaces) {
    const list = byOrg.get(ws.organizationId) ?? [];
    list.push(ws);
    byOrg.set(ws.organizationId, list);
  }

  return orgs.map((o) => {
    const own = byOrg.get(o.id) ?? [];
    const sum = (pick: (w: SuperAdminTeamRow) => number) =>
      own.reduce((acc, w) => acc + pick(w), 0);
    return {
      id: o.id,
      name: o.name,
      createdAt: o.createdAt.toISOString(),
      status: o.status as OrgStatus,
      statusReason: o.statusReason,
      statusUpdatedAt: o.statusUpdatedAt?.toISOString() ?? null,
      maxWorkspaces: o.maxWorkspaces,
      memberCount: seatsByOrg.get(o.id) ?? 0,
      contactCount: sum((w) => w.contactCount),
      conversationCount: sum((w) => w.conversationCount),
      messageCount: sum((w) => w.messageCount),
      workspaces: own,
    };
  });
}

export async function getTeamDetailForSuperAdmin(
  workspaceId: string,
): Promise<SuperAdminTeamDetail | null> {
  // `findFirst`, not `findUnique`: the where carries a RELATION filter
  // alongside the id, and `findUnique` accepts only unique fields. Prisma's XOR
  // union types let the bad shape compile clean and then throw at runtime — the
  // exact failure mode `check:prisma-fields` exists for.
  const team = await db.workspace.findFirst({
    // The platform anchor's workspace is not a customer workspace, and the
    // console never links to it (its org is filtered out of the list) — but the
    // detail page is reachable by typing the URL, so exclude it here too rather
    // than relying on nothing linking there.
    where: { id: workspaceId, organization: { isPlatform: false } },
    select: {
      id: true,
      name: true,
      createdAt: true,
      organizationId: true,
      // Seat cap is per-WORKSPACE; the workspace cap is per-ORGANISATION.
      maxMembers: true,
      organization: {
        select: {
          status: true,
          statusReason: true,
          statusUpdatedAt: true,
          maxWorkspaces: true,
          // Sibling count so the page can show "N / max workspaces".
          _count: { select: { workspaces: true } },
        },
      },
      channelConnections: {
        where: { channel: "whatsapp" },
        select: { config: true },
      },
      _count: {
        select: {
          // `Workspace.users` became `members` in the workspace rename. Prisma
          // select/_count fields are NOT typechecked, so this compiled clean and
          // only failed at request time with a 400 invalid_request.
          members: true,
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
  //
  // Selected by ORGANISATION, not by membership of this workspace. `User` hangs
  // off `Organization`, so `workspaceMemberships.some(workspaceId)` silently
  // omitted anyone belonging to no workspace. Two routine ways to get there:
  //   - an admin removes someone from their last workspace — that deletes the
  //     `WorkspaceMember` row and keeps the account (workspaces.service.ts);
  //   - a social signup whose phase-2 workspace seeding failed, leaving a user
  //     with an org and nothing else (oauth-provision.controller.ts).
  // Both accounts still hold a globally-unique email, so they are exactly what
  // an operator needs to see — and they were invisible on the only screen that
  // lists members. Everyone in the org is listed; `inWorkspace` says who
  // actually has access to THIS one.
  const members = await db.user.findMany({
    where: { organizationId: team.organizationId },
    orderBy: [{ name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      isSuperAdmin: true,
      orgRole: true,
      workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 },
      deactivatedAt: true,
      createdAt: true,
    },
  });

  return {
    team: {
      id: team.id,
      name: team.name,
      createdAt: team.createdAt.toISOString(),
      organizationId: team.organizationId,
      status: team.organization.status as OrgStatus,
      statusReason: team.organization.statusReason,
      statusUpdatedAt: team.organization.statusUpdatedAt?.toISOString() ?? null,
      maxMembers: team.maxMembers,
      maxWorkspaces: team.organization.maxWorkspaces,
      workspaceCount: team.organization._count.workspaces,
      whatsappConnected: Boolean(waCfg.phoneNumberId),
      whatsappDisplayNumber: waCfg.displayPhoneNumber ?? null,
      userCount: team._count.members,
      contactCount: team._count.contacts,
      conversationCount: team._count.conversations,
      messageCount: team._count.messages,
      broadcastCount: team._count.broadcasts,
    },
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      // Role IN THIS WORKSPACE. Meaningless when `inWorkspace` is false — the
      // UI shows the org role there instead of implying workspace access the
      // person doesn't have.
      role: m.workspaceMemberships[0]?.role ?? "agent",
      inWorkspace: m.workspaceMemberships.length > 0,
      orgRole: m.orgRole as OrgRole,
      isSuperAdmin: m.isSuperAdmin,
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
      // Every org aggregate below excludes the platform anchor: it is not a
      // customer, so counting it inflates "how many organizations are on the
      // platform" by one, permanently.
      db.organization.groupBy({
        by: ["status"],
        where: { isPlatform: false },
        _count: { _all: true },
      }),
      db.user.count(),
      db.contact.count(),
      db.conversation.count(),
      db.message.count(),
      db.broadcast.count(),
      db.organization.count({ where: { isPlatform: false, createdAt: { gte: since } } }),
      db.organization.findMany({
        where: { isPlatform: false, status: "pending" },
        orderBy: { createdAt: "desc" },
        take: 8,
        select: { id: true, name: true, createdAt: true },
      }),
    ]);

  const countFor = (s: OrgStatus) =>
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
