import type { Role } from "@prisma/client";
import {
  AssignmentEligibility,
  AssignmentOverflow,
  AssignmentStrategy,
  ASSIGNMENT_ELIGIBILITIES,
  ASSIGNMENT_OVERFLOWS,
  ASSIGNMENT_STRATEGIES,
  type AssignmentReason,
} from "@ccp/shared/assignment/types";

/**
 * PURE assignee selection. No IO, no Prisma, no clock — every input is an
 * argument, so every routing scenario is unit-testable without a database
 * (see select.spec.ts). `resolve.ts` is the thin DB adapter that loads these
 * inputs, calls `selectAssignee`, and commits the bookkeeping.
 *
 * The selection pipeline, in order — each stage narrows the pool:
 *
 *   1. STRATEGY SHORT-CIRCUITS   manual → nobody, fixed → the pinned member.
 *   2. POOL                      membership (all-members vs explicit squad),
 *                                per-member enabled flag, role filter,
 *                                caller exclusions, weight > 0 (weighted only).
 *   3. ELIGIBILITY TIER          presence / availability (see tierFor).
 *   4. CAPACITY                  drop anyone at their open-conversation cap.
 *   5. OVERFLOW                  what to do when 3 or 4 emptied the pool.
 *   6. PICK                      least_busy | round_robin | weighted.
 *
 * Invariants this file guarantees, and which the callers rely on:
 *   - It NEVER returns a userId that wasn't in `members` (except an explicitly
 *     configured `fixedUserId`/`fallbackUserId`, which the caller validates).
 *   - It never throws. Every degenerate input (no members, all weights zero,
 *     a cursor pointing at someone who left) resolves to a decision with a
 *     `reason` explaining itself.
 *   - It is deterministic: the same inputs always produce the same output, so
 *     the settings "preview" and the live path can't disagree.
 */

/** The policy fields selection actually reads. Kept structural (not the Prisma
 *  row type) so tests can build one inline and the settings preview can pass an
 *  unsaved draft. */
export interface SelectablePolicy {
  id: string;
  name: string;
  strategy: AssignmentStrategy;
  eligibility: AssignmentEligibility;
  eligibleRoles: Role[];
  includeAllMembers: boolean;
  defaultMaxOpen: number | null;
  overflow: AssignmentOverflow;
  fallbackUserId: string | null;
  fixedUserId: string | null;
  cursorUserId: string | null;
  /** Continuity: send a returning customer back to the agent who already
   *  knows them, when that agent is genuinely available. */
  preferPreviousAgent: boolean;
}

/** One active team member, merged with their optional per-policy override row.
 *  `members` MUST be in a stable order (createdAt, then id) — rotation depends
 *  on it, and an unstable order would make the cursor meaningless. */
export interface SelectableMember {
  id: string;
  role: Role;
  /** `User.availabilityStatus`; null/"available" both count as available. */
  availabilityStatus: string | null;
  /** Non-closed conversations currently assigned to them, team-wide. */
  openCount: number;
  /** True when an TeamMember row exists for this policy. */
  hasOverride: boolean;
  /** From the override row (defaults when absent). */
  enabled: boolean;
  weight: number;
  maxOpen: number | null;
  served: number;
}

export interface SelectInput {
  policy: SelectablePolicy;
  members: SelectableMember[];
  /** Connected userIds, or null when this process can't see sockets (a
   *  standalone worker). Null degrades presence-based tiers to availability. */
  onlineUserIds: Set<string> | null;
  /** Never pick these (the agent being rebalanced off, a member that just
   *  failed validation on a retry, someone already assigned elsewhere). */
  excludeUserIds?: readonly string[];
  /** The agent who last handled this customer, inside the policy's continuity
   *  window. `resolve.ts` looks this up; selection only decides whether they
   *  are still a legitimate choice. Null when there's no history. */
  previousUserId?: string | null;
}

export interface SelectResult {
  userId: string | null;
  reason: AssignmentReason;
  /** How many members survived stages 2–4. Surfaced in the preview UI and the
   *  debug log so "why nobody?" is answerable. */
  candidateCount: number;
}

const isStatusAvailable = (s: string | null): boolean =>
  s == null || s === "available";

/** Effective concurrent-open cap for a member. Null = uncapped; 0 = benched
 *  (they are eligible but can never be under cap, so they only receive work via
 *  the `ignore_capacity` overflow). Negatives are clamped to 0 rather than
 *  wrapping to "uncapped", which would be the dangerous reading. */
function capOf(member: SelectableMember, policy: SelectablePolicy): number | null {
  const cap = member.maxOpen ?? policy.defaultMaxOpen;
  return cap == null ? null : Math.max(0, cap);
}

/**
 * Stage 2 — membership, role filter, exclusions.
 *
 * `includeAllMembers` inverts what an override row MEANS: when true the pool
 * is everyone and a row is an opt-OUT/tuning knob; when false the pool is only
 * the rows (an explicit squad). Getting this backwards would silently route to
 * the whole company, so it's a single expression with both branches spelled out.
 */
function buildPool(
  members: SelectableMember[],
  policy: SelectablePolicy,
  exclude: ReadonlySet<string>,
): SelectableMember[] {
  return members.filter((m) => {
    if (exclude.has(m.id)) return false;
    if (policy.includeAllMembers) {
      // Everyone is in unless they have a row that opts them out.
      if (m.hasOverride && !m.enabled) return false;
    } else {
      // Explicit squad: a row is required, and it must be enabled.
      if (!m.hasOverride || !m.enabled) return false;
    }
    if (policy.eligibleRoles.length > 0 && !policy.eligibleRoles.includes(m.role)) {
      return false;
    }
    // A zero weight is the documented way to bench someone in a weighted
    // policy without deleting their configuration. Other strategies ignore
    // weight entirely, so this must not filter there.
    if (policy.strategy === "weighted" && m.weight <= 0) return false;
    return true;
  });
}

/**
 * Stage 3 — presence / availability tier.
 *
 * `online_first` is the tiered default: online+available → available → the
 * policy's OVERFLOW rule. It used to degrade to the whole active pool as a
 * final tier ("never lands nowhere"), which assigned a 2am inbound to an
 * off-shift agent and made `overflow: leave_unassigned` unreachable — removed
 * 2026-08-10; an empty tier now parks the thread in the Unassigned queue like
 * the strict tiers do (or routes to the fallback user when the policy names
 * one).
 *
 * When `onlineUserIds` is null this process has no socket visibility at all
 * (a standalone worker — in the api process the resolver is wired at boot and
 * a restart yields an EMPTY set instead). Presence-based tiers then FAIL OPEN
 * to availability rather than returning nobody — a routing blackout because
 * the picker is running in the wrong process would be a much worse failure
 * than briefly assigning to someone with no tab open.
 */
function tierFor(
  pool: SelectableMember[],
  eligibility: AssignmentEligibility,
  onlineUserIds: Set<string> | null,
): SelectableMember[] {
  const available = pool.filter((m) => isStatusAvailable(m.availabilityStatus));
  const online = onlineUserIds
    ? available.filter((m) => onlineUserIds.has(m.id))
    : null;

  switch (eligibility) {
    case "any_active":
      return pool;
    case "available_only":
      return available;
    case "online_only":
      // Fail open to availability when presence is unknowable here.
      return online ?? available;
    case "online_first":
    default:
      if (online && online.length > 0) return online;
      if (available.length > 0) return available;
      // Nobody online AND nobody available (2am, whole team off-shift): let
      // the policy's OVERFLOW rule decide instead of degrading to the whole
      // active pool. The old `return pool` here meant a night inbound was
      // assigned to whoever was asleep and `overflow: leave_unassigned` was
      // unreachable — the thread now parks in the visible Unassigned queue
      // (or goes to the fallback user if the policy names one). Product
      // decision 2026-08-10.
      return [];
  }
}

/** Stage 6a — least_busy: fewest open, rotation as the tie-break. */
function pickLeastBusy(
  candidates: SelectableMember[],
  cursorUserId: string | null,
): SelectableMember {
  const min = Math.min(...candidates.map((m) => m.openCount));
  const tied = candidates.filter((m) => m.openCount === min);
  return rotate(tied, cursorUserId);
}

/**
 * Stage 6b — round_robin: strict turn-taking, load ignored.
 *
 * Rotation is computed over the FULL candidate list rather than a filtered
 * subset so the cursor keeps its meaning: "the last person who got one".
 */
function rotate(
  candidates: SelectableMember[],
  cursorUserId: string | null,
): SelectableMember {
  const idx = cursorUserId ? candidates.findIndex((m) => m.id === cursorUserId) : -1;
  // idx === -1 covers both "no cursor yet" and "the cursor points at someone
  // who has since left / been filtered out" — both restart at the top of the
  // stable order, which is the only defensible behavior.
  return candidates[idx === -1 ? 0 : (idx + 1) % candidates.length]!;
}

/**
 * Stage 6c — weighted: lowest served-to-weight ratio wins.
 *
 * This is deficit round-robin, not a random draw: over N assignments the split
 * converges EXACTLY to the configured ratio, and it's deterministic, so an
 * admin who sets 50/20 can verify it. A member who has served 5 with weight 50
 * (ratio 0.1) outranks one who served 3 with weight 20 (ratio 0.15).
 *
 * Ties (including the all-zero cold start) fall through to rotation so a fresh
 * policy doesn't dump its first N conversations on whoever sorts first.
 *
 * Overflow is a non-issue: `served` is an Int4 and ratios are scale-free, so
 * nothing needs renormalizing at any realistic volume. The one real hazard —
 * a member ADDED later having served 0 and vacuuming up every conversation
 * until they catch up — is handled at WRITE time by seeding their `served` to
 * the pool's current ratio (see AssignmentService.syncMembers).
 */
function pickWeighted(
  candidates: SelectableMember[],
  cursorUserId: string | null,
): SelectableMember {
  let best = Number.POSITIVE_INFINITY;
  for (const m of candidates) {
    const ratio = m.served / m.weight;
    if (ratio < best) best = ratio;
  }
  // Relative epsilon so 3/50 and 6/100 tie despite binary-float noise.
  const threshold = best + Math.abs(best) * 1e-9 + 1e-9;
  const tied = candidates.filter((m) => m.served / m.weight <= threshold);
  return rotate(tied, cursorUserId);
}

/**
 * Resolve one assignee. See the file header for the pipeline; every early
 * return carries the `reason` that explains it.
 */
export function selectAssignee(input: SelectInput): SelectResult {
  const { policy, members, onlineUserIds } = input;
  const exclude = new Set(input.excludeUserIds ?? []);

  // 1. Strategy short-circuits.
  if (policy.strategy === "manual") {
    return { userId: null, reason: "manual_strategy", candidateCount: 0 };
  }
  if (policy.strategy === "fixed") {
    const target = policy.fixedUserId;
    // A fixed target that's been excluded (e.g. they're the one going offline)
    // or is no longer an active member falls through to the overflow rule
    // rather than silently pinning work onto a ghost.
    const stillValid =
      target != null && !exclude.has(target) && members.some((m) => m.id === target);
    if (stillValid) {
      return { userId: target, reason: "fixed", candidateCount: 1 };
    }
    return applyOverflow(policy, [], exclude, members, "no_candidates");
  }

  // 2–3. Pool → eligibility tier.
  const pool = buildPool(members, policy, exclude);
  if (pool.length === 0) {
    return applyOverflow(policy, [], exclude, members, "no_candidates");
  }
  const tier = tierFor(pool, policy.eligibility, onlineUserIds);
  if (tier.length === 0) {
    return applyOverflow(policy, [], exclude, members, "no_candidates");
  }

  // 4. Capacity.
  const withCapacity = tier.filter((m) => {
    const cap = capOf(m, policy);
    return cap == null || m.openCount < cap;
  });

  // 4b. CONTINUITY — a returning customer goes back to the agent who already
  // knows them, but only if that agent survived stages 2–4 on their own merits.
  // Deliberately placed AFTER eligibility and capacity, never before: pinning a
  // customer to someone who is offline or already full would trade a small
  // familiarity win for a large wait, which is the wrong trade every time.
  // It also sits after the exclusion filter, so a rebalance can still move work
  // off the very agent this would otherwise prefer.
  if (policy.preferPreviousAgent && input.previousUserId) {
    const previous = withCapacity.find((m) => m.id === input.previousUserId);
    if (previous) {
      return {
        userId: previous.id,
        reason: "previous_agent",
        candidateCount: withCapacity.length,
      };
    }
  }

  // 5. Overflow — everyone in the tier is at their cap.
  if (withCapacity.length === 0) {
    if (policy.overflow === "ignore_capacity") {
      const picked = pickWithin(tier, policy);
      return {
        userId: picked.id,
        reason: "overflow_uncapped",
        candidateCount: tier.length,
      };
    }
    return applyOverflow(policy, tier, exclude, members, "at_capacity");
  }

  // 6. Pick.
  const picked = pickWithin(withCapacity, policy);
  return { userId: picked.id, reason: "picked", candidateCount: withCapacity.length };
}

function pickWithin(
  candidates: SelectableMember[],
  policy: SelectablePolicy,
): SelectableMember {
  switch (policy.strategy) {
    case "round_robin":
      return rotate(candidates, policy.cursorUserId);
    case "weighted":
      return pickWeighted(candidates, policy.cursorUserId);
    case "least_busy":
    default:
      return pickLeastBusy(candidates, policy.cursorUserId);
  }
}

/**
 * Stage 5 — nobody eligible / everybody capped.
 *
 * `fallback_user` is only honored when the fallback is a real, non-excluded
 * member; a stale id degrades to leave-unassigned so a misconfigured policy
 * parks work in the visible triage queue instead of black-holing it.
 */
function applyOverflow(
  policy: SelectablePolicy,
  tier: SelectableMember[],
  exclude: ReadonlySet<string>,
  members: SelectableMember[],
  reason: AssignmentReason,
): SelectResult {
  if (policy.overflow === "fallback_user" && policy.fallbackUserId) {
    const id = policy.fallbackUserId;
    if (!exclude.has(id) && members.some((m) => m.id === id)) {
      return { userId: id, reason: "fallback", candidateCount: tier.length };
    }
  }
  if (policy.overflow === "ignore_capacity" && tier.length > 0) {
    const picked = pickWithin(tier, policy);
    return {
      userId: picked.id,
      reason: "overflow_uncapped",
      candidateCount: tier.length,
    };
  }
  return { userId: null, reason, candidateCount: tier.length };
}

/**
 * Boot assertion: the hand-written string unions in @ccp/shared (which
 * `apps/web` uses, since it must not import @prisma/client) must stay in
 * lockstep with the Prisma enums. Adding a Prisma enum value without updating
 * the shared union would make the settings UI silently unable to render a
 * policy — so we fail the boot instead. Called from AssignmentModule.onModuleInit.
 */
export function assertAssignmentEnumParity(prismaEnums: {
  AssignmentStrategy: Record<string, string>;
  AssignmentEligibility: Record<string, string>;
  AssignmentOverflow: Record<string, string>;
}): void {
  const check = (name: string, prisma: Record<string, string>, shared: readonly string[]) => {
    const a = Object.values(prisma).sort().join(",");
    const b = [...shared].sort().join(",");
    if (a !== b) {
      throw new Error(
        `${name} drift: prisma=[${a}] shared=[${b}] — update packages/shared/src/assignment/types.ts`,
      );
    }
  };
  check("AssignmentStrategy", prismaEnums.AssignmentStrategy, ASSIGNMENT_STRATEGIES);
  check("AssignmentEligibility", prismaEnums.AssignmentEligibility, ASSIGNMENT_ELIGIBILITIES);
  check("AssignmentOverflow", prismaEnums.AssignmentOverflow, ASSIGNMENT_OVERFLOWS);
}
