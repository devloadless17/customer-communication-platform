import type { AssignmentPolicy, PrismaClient } from "@prisma/client";

import type {
  AssignmentContext,
  AssignmentDecision,
} from "@ccp/shared/assignment/types";

import { getOnlineUserIds } from "@/lib/conversations/presence-bridge";

import { pickRule } from "./rules";
import {
  selectAssignee,
  type SelectableMember,
  type SelectablePolicy,
} from "./select";

/**
 * DB adapter for the assignment engine: load the inputs `select.ts` needs,
 * run the pure pick, commit the bookkeeping (rotation cursor + weighted
 * counter). Nothing here decides anything — every rule lives in select.ts /
 * rules.ts so it stays unit-testable.
 *
 * Two performance devices, both load-bearing at "big org, heavy pressure"
 * scale — read them before changing anything here:
 *
 *   1. CONFIG CACHE. Policies + rules + settings are read on EVERY inbound
 *      when auto-assign is on. They change a few times a month. Cached per
 *      team with a short TTL and invalidated explicitly on write
 *      (`invalidateAssignmentCache`). Live open-conversation COUNTS are never
 *      cached — those are the whole point of least-busy.
 *
 *   2. IN-FLIGHT RESERVATIONS. Ten inbounds landing in the same 50ms all read
 *      the same `openCount` groupBy and would all pick the same least-busy
 *      agent — a stampede that the DB can't prevent because each assignment is
 *      a separate transaction. `reserve()` records a short-lived local +1 per
 *      picked user, folded into openCount on the next pick, so a burst spreads
 *      exactly the way a serialized stream would. Entries expire on their own,
 *      so a crash or a rolled-back assign can't leave a phantom load.
 *      Single-process by design; a second app instance is a named scaling
 *      cliff (CLAUDE.md §16) at which this moves to Redis.
 */

type Db = Pick<
  PrismaClient,
  | "assignmentPolicy"
  | "assignmentRule"
  | "assignmentSettings"
  | "assignmentPolicyMember"
  | "user"
  | "conversation"
>;

// ---------------------------------------------------------------------------
// Config cache
// ---------------------------------------------------------------------------

const CONFIG_TTL_MS = 15_000;

interface CachedConfig {
  policies: AssignmentPolicy[];
  rules: {
    id: string;
    name: string;
    policyId: string;
    enabled: boolean;
    position: number;
    conditions: unknown;
  }[];
  settings: AssignmentSettingsShape;
  expiresAt: number;
}

const configCache = new Map<string, CachedConfig>();

/**
 * Per-team invalidation generation.
 *
 * A plain `delete` is NOT enough for a read-through cache, and the bug it hides
 * is nasty: a reader that missed the cache is already awaiting its DB reads
 * when a writer commits and invalidates. The reader's *stale* rows then resolve
 * and get written into the cache AFTER the invalidation — pinning pre-write
 * config for the full TTL. In practice that meant an admin turning auto-assign
 * on (or, worse, OFF) saw it silently ignored for the next 15 seconds, and only
 * under load, which is exactly when it matters.
 *
 * So every read snapshots the generation before querying and only publishes its
 * result if the generation still matches. A racing write simply makes the
 * reader's result non-cacheable — it's still returned to that caller, which is
 * correct (it was a consistent read at the time it started), it just doesn't
 * poison anyone else.
 */
const cacheGeneration = new Map<string, number>();

/** Call after ANY write to policies / rules / settings so the next resolution
 *  sees it immediately instead of up to TTL later. */
export function invalidateAssignmentCache(workspaceId: string): void {
  configCache.delete(workspaceId);
  cacheGeneration.set(workspaceId, (cacheGeneration.get(workspaceId) ?? 0) + 1);
  // Detach any in-flight single-flighted load: its waiters keep their (still
  // consistent) read, but callers arriving AFTER this write start fresh
  // instead of joining a load that may predate it.
  configLoads.delete(workspaceId);
}

export interface AssignmentSettingsShape {
  autoAssignOnNewConversation: boolean;
  skipWhenAiHandling: boolean;
  autoAssignOnReopen: boolean;
  reassignOnOffline: boolean;
  reassignOfflineAfterMinutes: number;
  reassignOfflineOnlyPending: boolean;
  reassignOnDeactivate: boolean;
  aiHandoffPolicyId: string | null;
}

/** Behaviour-neutral defaults for a team with no settings row — every
 *  automatic trigger OFF, so an un-configured org behaves exactly as it did
 *  before this feature existed. */
export const DEFAULT_ASSIGNMENT_SETTINGS: AssignmentSettingsShape = {
  autoAssignOnNewConversation: false,
  skipWhenAiHandling: true,
  autoAssignOnReopen: false,
  reassignOnOffline: false,
  reassignOfflineAfterMinutes: 15,
  reassignOfflineOnlyPending: true,
  reassignOnDeactivate: true,
  aiHandoffPolicyId: null,
};

/**
 * Single-flight guard for cache misses. Concurrent misses used to each run
 * their own 3-query load and — worse — each get their OWN policy objects, so
 * the pick lock's in-memory cursor mutation didn't propagate across a
 * cold-cache burst and round_robin could still stampede on the first burst
 * after boot/expiry/invalidation. Sharing the in-flight promise means every
 * concurrent caller holds the SAME objects the lock then serializes over.
 */
const configLoads = new Map<string, Promise<CachedConfig>>();

async function loadConfig(db: Db, workspaceId: string): Promise<CachedConfig> {
  const cached = configCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const inFlight = configLoads.get(workspaceId);
  if (inFlight) return inFlight;

  const load = loadConfigFresh(db, workspaceId).finally(() => {
    configLoads.delete(workspaceId);
  });
  configLoads.set(workspaceId, load);
  return load;
}

async function loadConfigFresh(db: Db, workspaceId: string): Promise<CachedConfig> {
  // Snapshot BEFORE the reads — see `cacheGeneration`.
  const generation = cacheGeneration.get(workspaceId) ?? 0;

  const [policies, rules, settings] = await Promise.all([
    db.assignmentPolicy.findMany({
      where: { workspaceId, archivedAt: null },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    }),
    db.assignmentRule.findMany({
      where: { workspaceId, enabled: true },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        policyId: true,
        enabled: true,
        position: true,
        conditions: true,
      },
    }),
    db.assignmentSettings.findUnique({ where: { workspaceId } }),
  ]);

  const entry: CachedConfig = {
    policies,
    rules,
    settings: settings
      ? {
          autoAssignOnNewConversation: settings.autoAssignOnNewConversation,
          skipWhenAiHandling: settings.skipWhenAiHandling,
          autoAssignOnReopen: settings.autoAssignOnReopen,
          reassignOnOffline: settings.reassignOnOffline,
          reassignOfflineAfterMinutes: settings.reassignOfflineAfterMinutes,
          reassignOfflineOnlyPending: settings.reassignOfflineOnlyPending,
          reassignOnDeactivate: settings.reassignOnDeactivate,
          aiHandoffPolicyId: settings.aiHandoffPolicyId,
        }
      : DEFAULT_ASSIGNMENT_SETTINGS,
    expiresAt: Date.now() + CONFIG_TTL_MS,
  };
  // Only publish if nothing invalidated while we were reading. Otherwise return
  // the rows to THIS caller (a consistent read as of when it started) without
  // caching them for anyone else.
  if ((cacheGeneration.get(workspaceId) ?? 0) === generation) {
    configCache.set(workspaceId, entry);
  }
  return entry;
}

export async function loadAssignmentSettings(
  db: Db,
  workspaceId: string,
): Promise<AssignmentSettingsShape> {
  return (await loadConfig(db, workspaceId)).settings;
}

// ---------------------------------------------------------------------------
// In-flight reservations
// ---------------------------------------------------------------------------

const RESERVATION_TTL_MS = 10_000;

/** workspaceId → userId → expiry timestamps (one entry per in-flight pick). */
const reservations = new Map<string, Map<string, number[]>>();

function reserve(workspaceId: string, userId: string): void {
  const byUser = reservations.get(workspaceId) ?? new Map<string, number[]>();
  const list = byUser.get(userId) ?? [];
  list.push(Date.now() + RESERVATION_TTL_MS);
  byUser.set(userId, list);
  reservations.set(workspaceId, byUser);
}

/**
 * Drop ONE reservation for a pick whose write failed (member deactivated
 * mid-flight, CAS lost to a human). Without this the phantom +1 makes the
 * agent look busier than they are for the full TTL, skewing least-busy against
 * whoever just lost a race. The cursor/`served` advance from the same failed
 * pick is deliberately NOT rolled back — both are last-writer-wins fairness
 * hints, and un-advancing a cursor another pick may already have moved past
 * would corrupt the rotation it's trying to protect.
 */
export function releaseReservation(workspaceId: string, userId: string): void {
  const list = reservations.get(workspaceId)?.get(userId);
  if (list) list.pop();
}

/** Live reservation counts, pruning expired entries as it goes. */
function reservedCounts(workspaceId: string): Map<string, number> {
  const out = new Map<string, number>();
  const byUser = reservations.get(workspaceId);
  if (!byUser) return out;
  const now = Date.now();
  for (const [userId, list] of byUser) {
    const live = list.filter((t) => t > now);
    if (live.length === 0) byUser.delete(userId);
    else {
      byUser.set(userId, live);
      out.set(userId, live.length);
    }
  }
  if (byUser.size === 0) reservations.delete(workspaceId);
  return out;
}

/** Test seam — the reservation map is process-global. */
export function __resetAssignmentRuntimeState(): void {
  reservations.clear();
  configCache.clear();
  cacheGeneration.clear();
  pickLocks.clear();
  configLoads.clear();
}

// ---------------------------------------------------------------------------
// Per-policy pick serialization
// ---------------------------------------------------------------------------

/**
 * Reservations fix the least-busy stampede (they inflate `openCount`), but
 * round_robin and weighted read the CURSOR and `served` — and a burst of
 * simultaneous inbounds all read the same snapshot before any of them commits,
 * so strict turn-taking handed the whole burst to one agent. Serializing the
 * load→pick→commit window per (workspace, policy) makes a burst spread exactly
 * the way a sequential stream would: each queued pick sees the previous pick's
 * cursor mutation and committed `served` increment. Single-process by design,
 * same Redis cliff as the reservations above. The held window is a few ms
 * (one groupBy + one update), so this cannot back up under any realistic load.
 */
const pickLocks = new Map<string, Promise<void>>();

async function withPickLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = pickLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => gate);
  pickLocks.set(key, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Only clean up if no later pick has chained onto us.
    if (pickLocks.get(key) === chained) pickLocks.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function toSelectable(policy: AssignmentPolicy): SelectablePolicy {
  return {
    id: policy.id,
    name: policy.name,
    strategy: policy.strategy,
    eligibility: policy.eligibility,
    eligibleRoles: policy.eligibleRoles,
    includeAllMembers: policy.includeAllMembers,
    defaultMaxOpen: policy.defaultMaxOpen,
    overflow: policy.overflow,
    fallbackUserId: policy.fallbackUserId,
    fixedUserId: policy.fixedUserId,
    cursorUserId: policy.cursorUserId,
    preferPreviousAgent: policy.preferPreviousAgent,
  };
}

/**
 * The agent who already knows this customer, if the relationship is still warm.
 *
 * Scope is the PERSON, not the thread. Threads are per-contact-per-channel, so
 * a customer who spoke to Sara on WhatsApp and now writes on Instagram is the
 * same relationship — resolving through `Customer` is what makes continuity
 * omnichannel instead of per-inbox. Falls back to the contact's own thread when
 * there's no unified customer yet.
 *
 * Reads `lastAssignedUserId`, which is the durable pointer (`assignedUserId` is
 * cleared on close — precisely when history starts mattering). Bounded by
 * `lastAssignedAt` so a stale relationship doesn't pin a customer forever, and
 * validated against the live roster by `selectAssignee`, which only honors the
 * preference if that agent is still eligible AND under capacity.
 */
async function previousAgentFor(
  db: Db,
  workspaceId: string,
  conversationId: string,
  windowDays: number,
): Promise<string | null> {
  const conv = await db.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    select: {
      lastAssignedUserId: true,
      lastAssignedAt: true,
      contact: { select: { customerId: true } },
    },
  });
  if (!conv) return null;

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  // This thread's own history wins — it's the most specific signal.
  if (conv.lastAssignedUserId && conv.lastAssignedAt && conv.lastAssignedAt >= cutoff) {
    return conv.lastAssignedUserId;
  }

  // Otherwise look across the person's other channels.
  const customerId = conv.contact?.customerId;
  if (!customerId) return null;
  const sibling = await db.conversation.findFirst({
    where: {
      workspaceId,
      id: { not: conversationId },
      lastAssignedUserId: { not: null },
      lastAssignedAt: { gte: cutoff },
      contact: { customerId },
    },
    orderBy: { lastAssignedAt: "desc" },
    select: { lastAssignedUserId: true },
  });
  return sibling?.lastAssignedUserId ?? null;
}

/**
 * Implicit default for a team that has no `AssignmentPolicy` row.
 *
 * The migration backfilled every team that existed, and `ensureBootstrap`
 * creates one the first time an admin opens the settings page — but a team
 * registered after the migration and never configured has neither. Without
 * this, the AI handoff on a brand-new org would resolve `no_policy` and assign
 * nobody: a silent regression from the hardcoded behavior it replaced, on
 * exactly the orgs least likely to notice.
 *
 * Its settings reproduce that hardcoded behavior EXACTLY (least-busy,
 * online-first, everyone, no caps). Deliberately in-memory rather than a lazy
 * INSERT: routing runs on the inbound hot path and in workers, and a write
 * there would add a round trip plus a create race to every unconfigured team's
 * first conversation. `id: ""` marks it as unsaved — `commitPick` skips the
 * cursor write for it, which costs nothing (with no persisted cursor the
 * rotation just restarts, and least-busy doesn't depend on it).
 */
function implicitDefaultPolicy(workspaceId: string): AssignmentPolicy {
  const now = new Date(0);
  return {
    id: "",
    workspaceId,
    name: "Default",
    description: null,
    isDefault: true,
    strategy: "least_busy",
    eligibility: "online_first",
    eligibleRoles: [],
    includeAllMembers: true,
    defaultMaxOpen: null,
    overflow: "leave_unassigned",
    fallbackUserId: null,
    fixedUserId: null,
    cursorUserId: null,
    preferPreviousAgent: true,
    previousAgentWindowDays: 30,
    version: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Which policy handles this context.
 *
 * Precedence: an explicitly requested policy (a workflow step or a campaign
 * naming one) > the first matching rule > the team default. An explicit
 * policyId that no longer resolves falls back to the rules rather than failing
 * — a deleted policy must degrade, never block an assignment.
 */
export async function resolvePolicyFor(
  db: Db,
  workspaceId: string,
  ctx: AssignmentContext,
  requestedPolicyId?: string | null,
): Promise<{
  policy: AssignmentPolicy | null;
  ruleId: string | null;
  ruleName: string | null;
}> {
  const { policies, rules } = await loadConfig(db, workspaceId);
  if (policies.length === 0) {
    return { policy: implicitDefaultPolicy(workspaceId), ruleId: null, ruleName: null };
  }

  if (requestedPolicyId) {
    const explicit = policies.find((p) => p.id === requestedPolicyId);
    if (explicit) return { policy: explicit, ruleId: null, ruleName: null };
  }

  const rule = pickRule(rules, ctx);
  if (rule) {
    const byRule = policies.find((p) => p.id === rule.policyId);
    if (byRule) return { policy: byRule, ruleId: rule.id, ruleName: rule.name };
    // Rule points at an archived/deleted policy → treat as no match.
  }

  const fallback = policies.find((p) => p.isDefault) ?? policies[0]!;
  return { policy: fallback, ruleId: null, ruleName: null };
}

/**
 * Load candidates for a policy: every ACTIVE member of the team, merged with
 * their optional per-policy override row and their live open-conversation
 * count (+ in-flight reservations).
 *
 * `orderBy [createdAt, id]` is the stable order rotation depends on — it must
 * match `pickRoundRobinAssignee`'s historical order so an upgraded team's
 * rotation continues where it left off rather than jumping.
 */
async function loadMembers(
  db: Db,
  workspaceId: string,
  policyId: string,
): Promise<SelectableMember[]> {
  const [users, overrides, grouped] = await Promise.all([
    db.user.findMany({
      where: { workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null },
      select: {
        id: true,
        availabilityStatus: true,
        workspaceMemberships: { where: { workspaceId }, select: { role: true }, take: 1 },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.assignmentPolicyMember.findMany({
      where: { policyId },
      select: { userId: true, weight: true, maxOpen: true, enabled: true, served: true },
    }),
    db.conversation.groupBy({
      by: ["assignedUserId"],
      where: { workspaceId, assignedUserId: { not: null }, status: { not: "closed" } },
      _count: { _all: true },
    }),
  ]);

  const openCounts = new Map<string, number>();
  for (const g of grouped) {
    if (g.assignedUserId) openCounts.set(g.assignedUserId, g._count._all);
  }
  const reserved = reservedCounts(workspaceId);
  const overrideByUser = new Map(overrides.map((o) => [o.userId, o]));

  return users.map((u) => {
    const o = overrideByUser.get(u.id);
    return {
      id: u.id,
      role: u.workspaceMemberships[0]?.role ?? "agent",
      availabilityStatus: u.availabilityStatus,
      openCount: (openCounts.get(u.id) ?? 0) + (reserved.get(u.id) ?? 0),
      hasOverride: o != null,
      enabled: o?.enabled ?? true,
      weight: o?.weight ?? 1,
      maxOpen: o?.maxOpen ?? null,
      served: o?.served ?? 0,
    };
  });
}

/**
 * Resolve WHO should take this conversation — the single entry point every
 * caller uses. Does NOT write the assignment (that's `assignByPolicy`), so the
 * settings "preview" can call it read-only via `commit: false`.
 *
 * `commit` advances the rotation cursor and the weighted counter. It's a
 * best-effort write: losing it costs one slightly-unfair rotation step, never
 * correctness, so it must not fail the caller.
 */
export async function resolveAssignee(args: {
  db: Db;
  workspaceId: string;
  ctx: AssignmentContext;
  policyId?: string | null;
  /** The thread being routed. Enables continuity (`preferPreviousAgent`);
   *  omitted by the settings preview, which has no conversation. */
  conversationId?: string | null;
  /** Default true. False = dry run (settings preview) — no cursor/counter write. */
  commit?: boolean;
}): Promise<AssignmentDecision> {
  const { db, workspaceId, ctx, policyId, conversationId, commit = true } = args;

  const { policy, ruleId, ruleName } = await resolvePolicyFor(db, workspaceId, ctx, policyId);
  if (!policy) {
    return {
      userId: null,
      reason: "no_policy",
      policyId: null,
      policyName: null,
      ruleId: null,
      ruleName: null,
    };
  }

  // The whole load→pick→commit window runs under the per-policy lock so a
  // burst of concurrent picks rotates instead of stampeding (see pickLocks).
  return withPickLock(`${workspaceId}:${policy.id || "implicit"}`, async () => {
    const members = await loadMembers(db, workspaceId, policy.id);

    // Continuity lookup only when the policy asks for it and the caller told us
    // which conversation we're routing — the settings preview has no thread, so
    // it simply previews the strategy without a relationship bias.
    const previousUserId =
      policy.preferPreviousAgent && conversationId
        ? await previousAgentFor(db, workspaceId, conversationId, policy.previousAgentWindowDays)
        : null;

    const result = selectAssignee({
      policy: toSelectable(policy),
      members,
      onlineUserIds: getOnlineUserIds(workspaceId),
      excludeUserIds: ctx.excludeUserIds,
      previousUserId,
    });

    const decision: AssignmentDecision = {
      userId: result.userId,
      reason: result.reason,
      policyId: policy.id,
      policyName: policy.name,
      ruleId,
      ruleName,
    };

    if (commit && result.userId) {
      reserve(workspaceId, result.userId);
      // Advance the cursor on the CACHED row too, not just in the DB. `loadConfig`
      // hands back the cached policy object by reference for CONFIG_TTL_MS (15s),
      // and `rotate()` (round_robin) depends on NOTHING but the cursor — so a
      // DB-only write meant every pick in a TTL window saw the same stale cursor
      // and returned the same agent. "Strict turn-taking" degenerated into
      // 15-second shifts with the rest of the team idle. Mutating the shared
      // object is what makes the next pick inside the window see this one.
      policy.cursorUserId = result.userId;
      await commitPick(db, policy, result.userId).catch(() => {
        // Bookkeeping only — the assignment itself is already decided.
      });
    }
    return decision;
  });
}

/**
 * Advance the rotation cursor and, for weighted policies, the served counter.
 *
 * The counter increment is an atomic `{ increment: 1 }` so two concurrent
 * picks can't clobber each other's bump (a plain read-modify-write would
 * silently under-count and skew the ratio). The cursor is a last-writer-wins
 * scalar by design — it's a fairness hint, not state anything depends on.
 */
async function commitPick(
  db: Db,
  policy: AssignmentPolicy,
  userId: string,
): Promise<void> {
  // The implicit default (see implicitDefaultPolicy) has no row to write to.
  if (!policy.id) return;
  await db.assignmentPolicy.updateMany({
    where: { id: policy.id, workspaceId: policy.workspaceId },
    data: { cursorUserId: userId },
  });
  if (policy.strategy !== "weighted") return;
  // upsert, not update: with `includeAllMembers` a picked member may have no
  // override row yet, and weighted fairness needs somewhere to count.
  await db.assignmentPolicyMember.upsert({
    where: { policyId_userId: { policyId: policy.id, userId } },
    create: {
      workspaceId: policy.workspaceId,
      policyId: policy.id,
      userId,
      served: 1,
    },
    update: { served: { increment: 1 } },
  });
}
