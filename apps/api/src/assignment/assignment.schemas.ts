import { z } from "zod";

import {
  ASSIGNMENT_ELIGIBILITIES,
  ASSIGNMENT_LIMITS,
  ASSIGNMENT_OVERFLOWS,
  ASSIGNMENT_SOURCES,
  ASSIGNMENT_STRATEGIES,
} from "@ccp/shared/assignment/types";

/**
 * Zod contracts for the assignment settings API. Shared verbatim by the
 * internal routes and the `/v1` external API so a partner integration can't
 * create a policy the settings page then refuses to render — the `/v1` parity
 * rule (CLAUDE.md §12) applied to configuration, not just actions.
 */

const L = ASSIGNMENT_LIMITS;

const name = z.string().trim().min(1).max(L.maxNameLength);
const id = z.string().min(1).max(64);

const enumOf = <T extends string>(values: readonly T[]) =>
  z.enum(values as [T, ...T[]]);

export const AssignmentStrategySchema = enumOf(ASSIGNMENT_STRATEGIES);
export const AssignmentEligibilitySchema = enumOf(ASSIGNMENT_ELIGIBILITIES);
export const AssignmentOverflowSchema = enumOf(ASSIGNMENT_OVERFLOWS);
export const AssignmentSourceSchema = enumOf(ASSIGNMENT_SOURCES);

/** Per-member weight + capacity inside a policy. */
export const PolicyMemberSchema = z.object({
  userId: id,
  weight: z.number().int().min(0).max(L.maxWeight).default(1),
  maxOpen: z.number().int().min(0).max(L.maxOpenCap).nullable().optional(),
  enabled: z.boolean().default(true),
});

const policyBody = {
  name,
  description: z.string().trim().max(500).nullable().optional(),
  strategy: AssignmentStrategySchema.optional(),
  eligibility: AssignmentEligibilitySchema.optional(),
  eligibleRoles: z.array(z.enum(["admin", "manager", "agent"])).max(3).optional(),
  includeAllMembers: z.boolean().optional(),
  defaultMaxOpen: z.number().int().min(0).max(L.maxOpenCap).nullable().optional(),
  overflow: AssignmentOverflowSchema.optional(),
  fallbackUserId: id.nullable().optional(),
  fixedUserId: id.nullable().optional(),
  members: z.array(PolicyMemberSchema).max(L.maxMembersPerPolicy).optional(),
  // Continuity — send a returning customer back to the agent who already knows
  // them, when that agent is eligible AND under capacity.
  preferPreviousAgent: z.boolean().optional(),
  // 1 day to 1 year. Past the window the relationship is treated as cold.
  previousAgentWindowDays: z.number().int().min(1).max(365).optional(),
};

export const CreatePolicySchema = z.object(policyBody);
export type CreatePolicyInput = z.infer<typeof CreatePolicySchema>;

/**
 * Update carries `expectedVersion` for optimistic concurrency — same posture as
 * `AiAssistantConfig.configVersion`. Two admins editing routing at once is a
 * realistic scenario on a big floor, and silently overwriting the other's
 * weights would be invisible until traffic skewed.
 */
export const UpdatePolicySchema = z.object({
  ...policyBody,
  name: name.optional(),
  expectedVersion: z.number().int().min(1),
});
export type UpdatePolicyInput = z.infer<typeof UpdatePolicySchema>;

export const RuleConditionsSchema = z
  .object({
    channels: z.array(z.string().min(1)).max(20).optional(),
    tagIds: z.array(id).max(50).optional(),
    stageIds: z.array(id).max(50).optional(),
    sources: z.array(AssignmentSourceSchema).max(ASSIGNMENT_SOURCES.length).optional(),
    keywords: z.array(z.string().trim().min(1).max(80)).max(L.maxKeywordsPerRule).optional(),
    languages: z.array(z.string().trim().min(1).max(16)).max(30).optional(),
    isNewContact: z.boolean().optional(),
  })
  .strict();

export const CreateRuleSchema = z.object({
  name,
  policyId: id,
  enabled: z.boolean().default(true),
  conditions: RuleConditionsSchema.default({}),
});
export type CreateRuleInput = z.infer<typeof CreateRuleSchema>;

export const UpdateRuleSchema = z.object({
  name: name.optional(),
  policyId: id.optional(),
  enabled: z.boolean().optional(),
  conditions: RuleConditionsSchema.optional(),
});
export type UpdateRuleInput = z.infer<typeof UpdateRuleSchema>;

/** Full reorder — the client sends the complete ordered id list, so there is no
 *  ambiguity about what happens to rules it didn't mention. */
export const ReorderRulesSchema = z.object({
  ruleIds: z.array(id).max(L.maxRulesPerTeam),
});
export type ReorderRulesInput = z.infer<typeof ReorderRulesSchema>;

export const UpdateAssignmentSettingsSchema = z.object({
  autoAssignOnNewConversation: z.boolean().optional(),
  skipWhenAiHandling: z.boolean().optional(),
  autoAssignOnReopen: z.boolean().optional(),
  reassignOnOffline: z.boolean().optional(),
  // 1 minute is the floor: anything shorter and a browser refresh triggers a
  // reassignment storm. 1440 (a day) is the ceiling — beyond that the sweep is
  // pointless.
  reassignOfflineAfterMinutes: z.number().int().min(1).max(1440).optional(),
  reassignOfflineOnlyPending: z.boolean().optional(),
  reassignOnDeactivate: z.boolean().optional(),
  aiHandoffPolicyId: id.nullable().optional(),
  /**
   * Who an AGENT can see. "team" (default) = everyone sees everything;
   * "assigned" = role `agent` sees only conversations assigned to them.
   * admin / manager / superAdmin are never restricted.
   *
   * Lives on `Team`, not on AssignmentSettings, because it is a org-wide
   * access rule rather than a routing knob — but it is edited HERE because
   * "who can see what" and "who gets what" are one decision in the admin's
   * head, and splitting them across two pages guarantees one gets forgotten.
   */
  agentConversationVisibility: z.enum(["team", "assigned"]).optional(),
  expectedVersion: z.number().int().min(1).optional(),
});
export type UpdateAssignmentSettingsInput = z.infer<
  typeof UpdateAssignmentSettingsSchema
>;

/**
 * Dry-run: "if a WhatsApp message with tag VIP arrived right now, who gets
 * it?" Answers the question an admin actually has when configuring routing,
 * without waiting for real traffic. Read-only — never advances the rotation
 * cursor or the weighted counters.
 */
export const PreviewAssignmentSchema = z.object({
  source: AssignmentSourceSchema.default("inbound"),
  channel: z.string().min(1).nullable().optional(),
  tagIds: z.array(id).max(50).optional(),
  stageId: id.nullable().optional(),
  language: z.string().max(16).nullable().optional(),
  messageText: z.string().max(2000).nullable().optional(),
  isNewContact: z.boolean().optional(),
  policyId: id.nullable().optional(),
});
export type PreviewAssignmentInput = z.infer<typeof PreviewAssignmentSchema>;
