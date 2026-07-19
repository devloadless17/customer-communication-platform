import type { PrismaClient } from "@prisma/client";

import type { DomainEventOf, DomainEventType } from "@ccp/shared/events/types";

import { assignConversation } from "./mutations";
import { pickRoundRobinAssignee } from "./round-robin";

/**
 * Customer → human handoff. Applies the team's configured `aiHandoffAction`
 * (`none` | `unassign` | `assign_fixed` | `round_robin`) after the AI yields the
 * thread to a person — the customer asked for a human, or the native assistant
 * escalated.
 *
 * ONE shared implementation so both AI systems assign identically:
 *   - the legacy n8n autopilot, via the `/v1` `set-ai` "human" branch
 *     (ExternalV1MessagingService), and
 *   - the native AI Assistant, when its reply orchestrator decides `escalate`.
 *
 * Every action routes through the shared `assignConversation` mutation, so
 * `conversation.assigned` fires and the inbox updates live (same
 * realtime/audit/analytics path as a manual assign). System actor
 * (`changedByUserId: null`); `changedByApiKeyId` attributes the n8n call when
 * present, and is null for the in-process native escalate.
 *
 * Framework-agnostic (lib/): `db` + `publish` are injected. Best-effort by
 * contract — the caller's critical action (pausing the AI) has already
 * committed, so a handoff failure must degrade to "paused but unassigned", never
 * throw. Errors are surfaced via the optional `onError` sink (the caller logs).
 */

type Db = Pick<PrismaClient, "team" | "conversation" | "user" | "$transaction">;
type Publish = <K extends DomainEventType>(event: DomainEventOf<K>) => Promise<void>;

export async function runHandoffPolicy(args: {
  db: Db;
  publish: Publish;
  teamId: string;
  conversationId: string;
  /** Attributes the assignment to the calling API key (n8n); null for native. */
  changedByApiKeyId?: string | null;
  /** Optional log sink for the two non-fatal degradations below. */
  onError?: (message: string) => void;
}): Promise<void> {
  const { db, publish, teamId, conversationId, changedByApiKeyId = null, onError } = args;

  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { aiHandoffAction: true, aiHandoffAssigneeId: true },
  });
  if (!team || team.aiHandoffAction === "none") return;

  let targetUserId: string | null = null;
  if (team.aiHandoffAction === "assign_fixed") {
    targetUserId = team.aiHandoffAssigneeId;
    if (!targetUserId) return; // misconfigured (no member set) → leave as-is
  } else if (team.aiHandoffAction === "round_robin") {
    targetUserId = await pickRoundRobinAssignee({ db, teamId });
    if (!targetUserId) return; // no eligible agent → leave unassigned
  }
  // "unassign" falls through with targetUserId = null.

  const assigned = await assignConversation({
    db,
    publish,
    teamId,
    conversationId,
    targetUserId,
    changedByUserId: null,
    changedByApiKeyId,
  });

  // A configured fixed assignee who's been deactivated/removed → don't fail the
  // handoff; fall back to leaving the thread unassigned for triage.
  if (!assigned.ok && "reason" in assigned && assigned.reason === "invalid_user") {
    onError?.(
      `handoff assign_fixed target ${targetUserId} invalid for team ${teamId}; leaving unassigned`,
    );
    await assignConversation({
      db,
      publish,
      teamId,
      conversationId,
      targetUserId: null,
      changedByUserId: null,
      changedByApiKeyId,
    });
  }
}
