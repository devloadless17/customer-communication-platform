import { db } from "@/lib/db";
import { operatorActorIds } from "@/lib/workspaces/operator-mask";

/**
 * Conversation analytics — incremental updates to the counters and
 * timestamps that feed the workflow conversation_closed trigger's many
 * exposed variables (first_response_time, resolution_time, etc.).
 *
 * Every helper here is fire-and-forget from the caller's perspective —
 * they swallow errors and log, because none of these are critical to the
 * primary domain event. The caller has already done its real work
 * (assigned, sent, closed). Analytics is bookkeeping; a missed update is
 * recoverable by re-deriving from Message at backfill time later.
 */

interface OnAssignedArgs {
  conversationId: string;
  workspaceId: string;
  assignedUserId: string | null;
  previousAssignedUserId: string | null;
}

export async function trackOnAssigned(args: OnAssignedArgs): Promise<void> {
  // Only count meaningful assignments (current → different). Self-reassigns
  // and self-unassigns don't bump counters.
  if (args.previousAssignedUserId === args.assignedUserId) return;
  // Skip pure unassign — counter measures "assignments to someone."
  if (args.assignedUserId === null) return;

  try {
    await db.conversation.update({
      where: { id: args.conversationId, workspaceId: args.workspaceId },
      data: {
        assignmentsCount: { increment: 1 },
        lastAssignedAt: new Date(),
        // firstAssignedAt only sets if currently null — the COALESCE-ish
        // semantics here are emulated by re-reading after update would
        // be expensive. Use updateMany with a where-condition instead.
      },
    });
    // Conditional firstAssignedAt set — runs only when the column is null.
    await db.conversation.updateMany({
      where: {
        id: args.conversationId,
        workspaceId: args.workspaceId,
        firstAssignedAt: null,
      },
      data: {
        firstAssignedAt: new Date(),
        firstAssignedUserId: args.assignedUserId,
      },
    });
  } catch (err) {
    console.error(
      `[conversations/analytics] trackOnAssigned conversation=${args.conversationId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

interface OnStatusChangedArgs {
  conversationId: string;
  workspaceId: string;
  previousStatus: string;
  newStatus: string;
  changedByUserId: string | null;
  /** API-key actor on /v1 + workflow closes — mirrors `changedByUserId` so the
   *  close metadata records WHO (key) closed it. Set on the same update as
   *  closedByUserId; nulled on reopen. */
  changedByApiKeyId?: string | null;
  /** Optional close-context written when newStatus === "closed". */
  closedCategory?: string | null;
  closedSummary?: string | null;
}

export async function trackOnStatusChanged(args: OnStatusChangedArgs): Promise<void> {
  if (args.previousStatus === args.newStatus) return;

  try {
    const data: Record<string, unknown> = {};
    if (args.newStatus === "closed") {
      data.closedAt = new Date();
      data.closedByUserId = args.changedByUserId;
      data.closedByApiKeyId = args.changedByApiKeyId ?? null;
      if (args.closedCategory !== undefined) data.closedCategory = args.closedCategory;
      if (args.closedSummary !== undefined) data.closedSummary = args.closedSummary;
    } else if (args.previousStatus === "closed") {
      // Reopening — wipe the close metadata so the next close's analytics
      // measure from THIS cycle, not the previous one.
      data.closedAt = null;
      data.closedByUserId = null;
      data.closedByApiKeyId = null;
      data.closedCategory = null;
      data.closedSummary = null;
    }
    if (Object.keys(data).length === 0) return;
    await db.conversation.update({
      where: { id: args.conversationId, workspaceId: args.workspaceId },
      data,
    });
  } catch (err) {
    console.error(
      `[conversations/analytics] trackOnStatusChanged conversation=${args.conversationId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

interface OnOutboundMessageArgs {
  conversationId: string;
  workspaceId: string;
  /** Null for system / workflow sends. */
  senderUserId: string | null;
}

export async function trackOnOutboundMessage(args: OnOutboundMessageArgs): Promise<void> {
  // "Response" semantics: an outbound message that comes after at least
  // one inbound message COUNTS as a response. If we've never had an
  // inbound on this conversation yet, the outbound is broadcast/outreach
  // and doesn't count toward responsesCount.
  //
  // Two concurrent outbounds against the same conversation both run this
  // function. The prior shape did read-then-write with the response
  // decision held in JS state, which could undercount responsesCount on a
  // tight inbound/outbound interleave: both reads saw incomingMessagesCount=0
  // at the moment, and neither incremented. The fix: push the conditional
  // into a single `updateMany` whose WHERE clause does the check
  // atomically. Two outbounds after one inbound: both updateMany rows match
  // `incomingMessagesCount > 0`, both increment — correct. Two outbounds
  // BEFORE any inbound: neither matches, neither increments — correct.
  // The firstResponseAt + firstResponseByUserId pair already use
  // predicate-gated updateMany, which keeps "first writer wins" correct.
  try {
    // OPERATOR EXCLUSION (CLAUDE.md, section 18) - the same "don't register,
    // rather than filter" rule presence applies. `responsesCount` and the
    // first-response stamp are AGENT-attributed metrics: the per-agent report
    // tables drop the operator via `withoutOperatorRows`, so counting their
    // sends into the workspace-level aggregates made the headline number and
    // the sum of the agent rows disagree by a gap the tenant cannot explain
    // (the missing responses were "answered" by someone the report is designed
    // to be unable to name). `outgoingMessagesCount` still increments below -
    // the message really was sent and the drift sweeper recomputes it from
    // rows. One indexed read on a fire-and-forget path; empty-set short-circuit
    // makes it free for every workflow/system send (null sender).
    const operatorIds = await operatorActorIds(db, [args.senderUserId], [args.workspaceId]);
    const senderIsOperator = args.senderUserId !== null && operatorIds.has(args.senderUserId);
    if (senderIsOperator) {
      await db.conversation.updateMany({
        where: { id: args.conversationId, workspaceId: args.workspaceId },
        data: { outgoingMessagesCount: { increment: 1 } },
      });
      return;
    }
    const result = await db.conversation.updateMany({
      where: {
        id: args.conversationId,
        workspaceId: args.workspaceId,
        incomingMessagesCount: { gt: 0 },
      },
      data: {
        outgoingMessagesCount: { increment: 1 },
        responsesCount: { increment: 1 },
      },
    });
    if (result.count === 0) {
      // No inbound yet — outbound is outreach. Bump outgoing only.
      await db.conversation.updateMany({
        where: { id: args.conversationId, workspaceId: args.workspaceId },
        data: { outgoingMessagesCount: { increment: 1 } },
      });
      return;
    }
    // First-response stamp — single predicate-gated updateMany. Race-safe:
    // only the FIRST concurrent outbound after an inbound matches
    // `firstResponseAt: null`; subsequent ones match zero rows.
    await db.conversation.updateMany({
      where: {
        id: args.conversationId,
        workspaceId: args.workspaceId,
        firstResponseAt: null,
        incomingMessagesCount: { gt: 0 },
      },
      data: {
        firstResponseAt: new Date(),
        firstResponseByUserId: args.senderUserId,
      },
    });
  } catch (err) {
    console.error(
      `[conversations/analytics] trackOnOutboundMessage conversation=${args.conversationId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
