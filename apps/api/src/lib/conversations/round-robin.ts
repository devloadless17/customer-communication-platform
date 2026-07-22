import type { PrismaClient } from "@prisma/client";

import type { AssignmentSource } from "@ccp/shared/assignment/types";

import { resolveAssignee } from "@/lib/assignment/resolve";
import { selectAssignee } from "@/lib/assignment/select";

/**
 * Compatibility shim over the assignment engine (`lib/assignment/`).
 *
 * This file used to BE the routing algorithm — one hardcoded strategy
 * (least-busy with online-first tiering and a rotation tie-break) shared by
 * the AI handoff and the workflow `assign_to` step. That algorithm now lives
 * in `lib/assignment/select.ts` as the `least_busy` strategy, and every team's
 * seeded default policy is configured to reproduce it EXACTLY, so nothing about
 * an un-configured team's behavior changed.
 *
 * The two exports are kept because they have real callers and, in
 * `chooseRoundRobin`'s case, a pure unit-test suite
 * (tests/e2e/workflows-events/round-robin.spec.ts) that is now doubling as the
 * proof of that equivalence. New code should call the engine directly:
 * `resolveAssignee` to decide, `assignByPolicy` to decide AND write.
 */

/**
 * Pure legacy selection — least-busy within the online-first tier, rotation as
 * the tie-break. Delegates to the engine with a synthetic `least_busy` policy
 * so there is exactly ONE implementation of the rule.
 */
export function chooseRoundRobin(args: {
  members: { id: string; availabilityStatus: string | null }[];
  onlineUserIds: Set<string> | null;
  openCounts: Map<string, number>;
  cursor: string | null;
}): string | null {
  const { members, onlineUserIds, openCounts, cursor } = args;
  return selectAssignee({
    policy: {
      id: "legacy",
      name: "legacy",
      strategy: "least_busy",
      eligibility: "online_first",
      eligibleRoles: [],
      includeAllMembers: true,
      defaultMaxOpen: null,
      overflow: "leave_unassigned",
      fallbackUserId: null,
      fixedUserId: null,
      cursorUserId: cursor,
      // The legacy pure helper has no customer context to look continuity up
      // from, so it stays off here. The real path (resolve.ts) enables it.
      preferPreviousAgent: false,
    },
    members: members.map((m) => ({
      id: m.id,
      // The legacy signature carries no role; the synthetic policy has an empty
      // `eligibleRoles`, so the value is never read.
      role: "agent",
      availabilityStatus: m.availabilityStatus,
      openCount: openCounts.get(m.id) ?? 0,
      hasOverride: false,
      enabled: true,
      weight: 1,
      maxOpen: null,
      served: 0,
    })),
    onlineUserIds,
  }).userId;
}

/**
 * Policy-driven assignee pick. Kept as a named helper so existing call sites
 * read naturally, but it is now fully configurable: whichever policy the
 * team's rules select for `source` decides the strategy, eligibility, weights
 * and capacity.
 */
export async function pickRoundRobinAssignee(args: {
  db: Parameters<typeof resolveAssignee>[0]["db"];
  workspaceId: string;
  /** Rule-matching source; defaults to the AI handoff path this shim served. */
  source?: AssignmentSource;
  policyId?: string | null;
}): Promise<string | null> {
  const { db, workspaceId, source = "ai_handoff", policyId } = args;
  const decision = await resolveAssignee({ db, workspaceId, ctx: { source }, policyId });
  return decision.userId;
}

/** Narrow Prisma surface the legacy signature advertised. Retained so callers
 *  typed against it keep compiling. */
export type RoundRobinDb = Pick<PrismaClient, "user" | "workspace" | "conversation">;
