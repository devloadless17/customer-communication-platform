import type { Channel } from "../types";

/**
 * Assignment routing contracts — shared by the api engine, the settings UI,
 * the broadcast composer and the `/v1` API so all four speak one vocabulary.
 *
 * Framework-agnostic and Prisma-free ON PURPOSE: `apps/web` must be able to
 * render a policy editor without importing @prisma/client. The string unions
 * below MIRROR the Prisma enums of the same name (schema.prisma, "Assignment
 * routing" section) — keep them in lockstep; `assertAssignmentEnumParity` in
 * apps/api/src/lib/assignment/select.ts fails the boot if they drift.
 */

/** How a policy picks among eligible, under-capacity candidates. */
export type AssignmentStrategy =
  | "round_robin"
  | "least_busy"
  | "weighted"
  | "fixed"
  | "manual";

/** Which members are candidates at pick time. */
export type AssignmentEligibility =
  | "online_first"
  | "online_only"
  | "available_only"
  | "any_active";

/** What happens when nobody is eligible / everybody is at capacity. */
export type AssignmentOverflow =
  | "leave_unassigned"
  | "ignore_capacity"
  | "fallback_user";

export const ASSIGNMENT_STRATEGIES: readonly AssignmentStrategy[] = [
  "round_robin",
  "least_busy",
  "weighted",
  "fixed",
  "manual",
] as const;

export const ASSIGNMENT_ELIGIBILITIES: readonly AssignmentEligibility[] = [
  "online_first",
  "online_only",
  "available_only",
  "any_active",
] as const;

export const ASSIGNMENT_OVERFLOWS: readonly AssignmentOverflow[] = [
  "leave_unassigned",
  "ignore_capacity",
  "fallback_user",
] as const;

/**
 * Where an assignment request came from. Rules can match on it, and every
 * resolution logs it, so "why did this land on Sara?" is answerable from the
 * audit trail alone.
 */
export type AssignmentSource =
  | "inbound" // first inbound on a brand-new conversation
  | "reopen" // new inbound on an existing unassigned/closed thread
  | "ai_handoff" // the built-in AI (or legacy n8n autopilot) escalated
  | "workflow" // a workflow `assign_to` step
  | "broadcast" // campaign pre-assignment
  | "api" // /v1 assign with a policy
  | "manual" // an admin explicitly ran the policy from the UI
  | "rebalance"; // offline / deactivation sweep

export const ASSIGNMENT_SOURCES: readonly AssignmentSource[] = [
  "inbound",
  "reopen",
  "ai_handoff",
  "workflow",
  "broadcast",
  "api",
  "manual",
  "rebalance",
] as const;

/**
 * Rule match conditions. ALL present clauses must match (AND); within a
 * clause ANY value matches (OR). An absent or empty clause is "don't care",
 * so `{}` is a catch-all — which is exactly what the lowest-priority rule
 * usually wants.
 */
export interface AssignmentRuleConditions {
  /** Conversation channel. */
  channels?: Channel[];
  /** Contact must carry at least one of these tags. */
  tagIds?: string[];
  /** Contact's pipeline stage. */
  stageIds?: string[];
  /** What triggered the assignment (see AssignmentSource). */
  sources?: AssignmentSource[];
  /** Case-insensitive substring match against the triggering message body. */
  keywords?: string[];
  /** Contact language code (prefix match: "en" matches "en-US"). */
  languages?: string[];
  /** True = only brand-new contacts; false = only returning ones. */
  isNewContact?: boolean;
}

/** The context a rule is evaluated against. Everything is optional — a caller
 *  that can't cheaply supply a field just leaves it out, and clauses depending
 *  on it are treated as NOT matching (fail closed, so a rule never fires on
 *  data it couldn't actually see). */
export interface AssignmentContext {
  source: AssignmentSource;
  channel?: Channel | null;
  tagIds?: string[];
  stageId?: string | null;
  messageText?: string | null;
  language?: string | null;
  isNewContact?: boolean;
  /** Excluded from the candidate pool (e.g. the agent we're rebalancing off,
   *  or an assignee that just failed validation). */
  excludeUserIds?: string[];
}

/** Why a resolution produced (or failed to produce) an assignee. Surfaced in
 *  the audit trail and the settings "test this policy" preview. */
export type AssignmentReason =
  | "previous_agent" // the customer already had a relationship with them
  | "picked" // normal selection
  | "fixed" // strategy = fixed
  | "fallback" // overflow = fallback_user
  | "overflow_uncapped" // overflow = ignore_capacity
  | "manual_strategy" // strategy = manual → deliberately no assignee
  | "no_policy" // team has no usable policy
  | "no_candidates" // nobody eligible
  | "at_capacity"; // everyone capped and overflow = leave_unassigned

export interface AssignmentDecision {
  userId: string | null;
  reason: AssignmentReason;
  policyId: string | null;
  policyName: string | null;
  /** Rule that selected the policy; null when the team default was used. */
  ruleId: string | null;
  ruleName: string | null;
}

/** Campaign assignment mode — mirrors the Prisma `BroadcastAssignmentMode`. */
export type BroadcastAssignmentMode =
  | "none"
  | "fixed"
  | "split_counts"
  | "split_percent"
  | "policy";

export const BROADCAST_ASSIGNMENT_MODES: readonly BroadcastAssignmentMode[] = [
  "none",
  "fixed",
  "split_counts",
  "split_percent",
  "policy",
] as const;

/** One row of a campaign split. `value` is a literal recipient count
 *  (split_counts) or a relative weight (split_percent). */
export interface BroadcastAssignmentSplitEntry {
  userId: string;
  value: number;
}

/** What to do with recipients left over after an exact-count split runs out. */
export type BroadcastAssignmentLeftover = "leave_unassigned" | "policy";

/** Hard bounds — enforced identically by the API schemas and the UI so a
 *  hand-rolled `/v1` call can't create a policy the settings page can't edit. */
export const ASSIGNMENT_LIMITS = {
  maxPoliciesPerTeam: 50,
  maxRulesPerTeam: 100,
  maxMembersPerPolicy: 200,
  maxWeight: 10_000,
  maxOpenCap: 10_000,
  maxKeywordsPerRule: 25,
  maxNameLength: 80,
} as const;
