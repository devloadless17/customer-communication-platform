import type {
  AssignmentDecision,
  AssignmentEligibility,
  AssignmentOverflow,
  AssignmentRuleConditions,
  AssignmentStrategy,
} from "@ccp/shared/assignment/types";
import type { Role } from "@ccp/shared/types";

/**
 * Wire shapes for GET /api/team/assignment. Declared here (not derived from
 * Prisma) because `apps/web` must not import @prisma/client — the shared string
 * unions in `@ccp/shared/assignment/types` are the contract, and the api asserts
 * at boot that they still match the Prisma enums.
 */

export interface PolicyMemberRow {
  userId: string;
  weight: number;
  maxOpen: number | null;
  enabled: boolean;
  served: number;
}

export interface PolicyRow {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  strategy: AssignmentStrategy;
  eligibility: AssignmentEligibility;
  eligibleRoles: Role[];
  includeAllMembers: boolean;
  defaultMaxOpen: number | null;
  overflow: AssignmentOverflow;
  fallbackUserId: string | null;
  fixedUserId: string | null;
  preferPreviousAgent: boolean;
  previousAgentWindowDays: number;
  version: number;
  members: PolicyMemberRow[];
}

export interface RuleRow {
  id: string;
  name: string;
  policyId: string;
  position: number;
  enabled: boolean;
  conditions: AssignmentRuleConditions;
}

export interface AssignmentSettingsRow {
  workspaceId: string;
  autoAssignOnNewConversation: boolean;
  skipWhenAiHandling: boolean;
  autoAssignOnReopen: boolean;
  reassignOnOffline: boolean;
  reassignOfflineAfterMinutes: number;
  reassignOfflineOnlyPending: boolean;
  reassignOnDeactivate: boolean;
  aiHandoffPolicyId: string | null;
  /** Org-wide read boundary: "team" (default) or "assigned". */
  agentConversationVisibility: "team" | "assigned";
  version: number;
}

export interface MemberRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatarUrl: string | null;
  availabilityStatus: string | null;
  /** Non-closed conversations currently assigned to them. */
  openCount: number;
}

export interface AssignmentOverview {
  policies: PolicyRow[];
  rules: RuleRow[];
  settings: AssignmentSettingsRow;
  members: MemberRow[];
}

export interface PreviewResult {
  decision: AssignmentDecision;
  user: { id: string; name: string; email: string; avatarUrl: string | null } | null;
}

/** Copy for the strategy picker. The distinction between the first two is the
 *  one admins get wrong, so both labels state the actual rule. */
export const STRATEGY_LABELS: Record<AssignmentStrategy, string> = {
  least_busy: "Balanced — fewest open chats first",
  round_robin: "Round robin — strict turn taking",
  weighted: "Weighted — by share per member",
  fixed: "Always one person",
  manual: "Manual — never auto-assign",
};

export const STRATEGY_HINTS: Record<AssignmentStrategy, string> = {
  least_busy:
    "Sends each conversation to whoever is carrying the fewest open chats. Self-balances when conversations run for different lengths. Recommended for most teams.",
  round_robin:
    "Everyone takes a turn in order, regardless of how loaded they are. Predictable, but one agent stuck on long chats still keeps receiving new ones.",
  weighted:
    "Split traffic by share. Give a senior agent 50 and a junior 20 and the senior receives 5 conversations for every 2 the junior gets — exactly, over time.",
  fixed: "Everything goes to one person. Useful for a triage lead or a solo channel.",
  manual:
    "This policy never assigns anyone. Use it to keep a slice of traffic in the Unassigned queue while the rest is automated.",
};

export const ELIGIBILITY_LABELS: Record<AssignmentEligibility, string> = {
  online_first: "Online first, then available, then anyone",
  online_only: "Only agents online right now",
  available_only: "Only agents marked available",
  any_active: "Anyone on the team",
};

export const ELIGIBILITY_HINTS: Record<AssignmentEligibility, string> = {
  online_first:
    "Prefers agents with the app actually open. Falls back to whoever is marked available, then to anyone — so a conversation is never left unowned.",
  online_only:
    "Strict. If nobody is connected, the conversation goes to the Unassigned queue instead of an agent who has gone home.",
  available_only:
    "Ignores whether the app is open and trusts the availability status (which follows working hours).",
  any_active: "Ignores presence, availability and working hours entirely.",
};

export const OVERFLOW_LABELS: Record<AssignmentOverflow, string> = {
  leave_unassigned: "Leave in the Unassigned queue",
  ignore_capacity: "Ignore the limits and assign anyway",
  fallback_user: "Send to a fallback person",
};
