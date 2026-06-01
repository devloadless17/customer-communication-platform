// Note: no `server-only` import — loaded by the NestJS api process via
// @swc-node/register, outside the Next bundler context.

/**
 * Workflow dispatch subscriber.
 *
 * Translates `DomainEvent`s into workflow triggers and enqueues runs via
 * `lib/workflows/dispatcher.ts`. Centralizes the trigger taxonomy in one
 * place — adding a new trigger to a domain event = one new case here, NOT
 * a new call site somewhere upstream.
 *
 * Order in the subscriber chain: WORKFLOW_DISPATCH tier (after analytics).
 * By the time this runs, socket-fanout has lit up live clients, audit has
 * written the timeline row, and analytics has bumped the conversation
 * counters / firstResponseAt / closedAt. (outbound-webhooks runs after this
 * one — neither depends on the other.)
 *
 * Snapshot source (M1 contract):
 *   Conversation snapshots come FROM the event payload (`e.conversation`),
 *   NOT a fresh DB read. The publishers (lib/conversations/mutations.ts,
 *   lib/providers/ingest{,-call}.ts, messages.service.ts) build a post-CAS
 *   snapshot with the predicted analytics writes (closedAt / closedByUserId /
 *   assignmentsCount / firstAssignedAt etc.) applied in-memory and attach it
 *   verbatim. The dispatcher pins this snapshot onto WorkflowRun.eventPayload
 *   and the runner reads from it (see dispatcher.ts M1 comment). A fresh DB
 *   read here would race: between the publisher commit and this subscriber
 *   running, a concurrent UNRELATED mutation (a teammate's assign happening
 *   at the same instant as a customer's reopen, say) could land on the row
 *   and leak into the snapshot the workflow run sees — even though it has
 *   nothing to do with the event that triggered this run.
 *
 * `dispatch()` already swallows its own errors and applies retry-with-backoff
 * around the Redis enqueue, so this subscriber doesn't need extra guarding.
 *
 * INVARIANT — DO NOT subscribe to `broadcast.*` events here.
 * --------------------------------------------------------------------------
 * `broadcast.recipient_message_sent` and `broadcast.conversation_reopened`
 * are dedicated event types specifically so a 1k-recipient broadcast does
 * NOT trigger 1k workflow runs. Only socket-fanout subscribes to them. If
 * you find yourself wanting a workflow-on-broadcast, add a separate, fully-
 * intentional event type and corresponding subscriber here — do not
 * shortcut through the existing broadcast.* fanouts. Same isolation logic
 * exists in `audit.ts` for the same reason (no 1k audit rows per
 * broadcast). See CLAUDE.md "Bus events introduced for the cleanup".
 */

import type { DomainEventOf, DomainEventType } from "@ccp/shared/events/types";

import { subscribe as busSubscribe, SubscriberPriority } from "@/lib/events/bus";
import { dispatch } from "@/lib/workflows/dispatcher";

export function registerWorkflowDispatchSubscribers(): () => void {
  // WORKFLOW_DISPATCH tier — runs after analytics. Conversation snapshots
  // come from the EVENT PAYLOAD (publisher-built, post-CAS, with predicted
  // analytics writes baked in), not a fresh DB read. See the file-level
  // doc-comment for the race rationale.
  const offs: Array<() => void> = [];
  const subscribe = <K extends DomainEventType>(
    type: K,
    handler: (e: DomainEventOf<K>) => void | Promise<void>,
  ) => {
    offs.push(busSubscribe(type, handler, SubscriberPriority.WORKFLOW_DISPATCH));
  };

  // ---- message.received → message_received (+ conversation_created on first) ----
  subscribe("message.received", async (e) => {
    if (e.isNewConversation) {
      await dispatch(e.teamId, "conversation_created", {
        conversation: e.conversation,
        contact: e.contact,
      });
    }
    await dispatch(e.teamId, "message_received", {
      message: e.workflowMessage,
      conversation: e.conversation,
      contact: e.contact,
      recentMessages: e.recentMessages,
    });
  });

  // ---- conversation.assigned → conversation_assigned (skip self-reassign) ----
  subscribe("conversation.assigned", async (e) => {
    if (e.silent) return; // workflow-step driven; skip chain dispatch
    if (e.previousAssignedUserId === e.newAssignedUserId) return;
    // Snapshot rides on the event payload — see file-level doc-comment.
    await dispatch(e.teamId, "conversation_assigned", {
      conversation: e.conversation,
      contact: e.contact,
      assignedUser: e.assignedUser
        ? { id: e.assignedUser.id, name: e.assignedUser.name, email: e.assignedUser.email }
        : null,
      previousAssignedUserId: e.previousAssignedUserId,
    });
  });

  // ---- conversation.status_changed → 1, 2, or 3 triggers ----
  subscribe("conversation.status_changed", async (e) => {
    if (e.silent) return; // workflow-step driven; skip chain dispatch
    if (e.previousStatus === e.newStatus) return;
    // Snapshot rides on the event payload — see file-level doc-comment.
    const snapshot = e.conversation;

    await dispatch(e.teamId, "conversation_status_changed", {
      conversation: snapshot,
      contact: e.contact,
      previousStatus: e.previousStatus,
      newStatus: e.newStatus,
      changedByUserId: e.changedByUserId,
    });
    if (e.newStatus === "open") {
      await dispatch(e.teamId, "conversation_opened", {
        conversation: snapshot,
        contact: e.contact,
        previousStatus: e.previousStatus,
        openedByUserId: e.changedByUserId,
      });
    } else if (e.newStatus === "closed") {
      await dispatch(e.teamId, "conversation_closed", {
        conversation: snapshot,
        contact: e.contact,
        previousStatus: e.previousStatus,
        closedByUserId: e.changedByUserId,
        closedCategory: snapshot.closedCategory,
        closedSummary: snapshot.closedSummary,
      });
    }
  });

  // ---- contact.updated → 1 dispatch per changed field + 1 if stage changed
  // ---- + 1 per added/removed tag ----
  subscribe("contact.updated", async (e) => {
    if (e.silent) return; // workflow-step driven; skip chain dispatch
    // Normalize `Contact.stageId` from `string | null | undefined` to the
    // strict `string | null` the workflow trigger payload expects.
    const newStageId = e.contact.stageId ?? null;
    const hasTagChanges =
      (e.tagChanges?.added.length ?? 0) > 0 || (e.tagChanges?.removed.length ?? 0) > 0;
    if (
      e.fieldChanges.length === 0 &&
      e.previousStageId === newStageId &&
      !hasTagChanges
    ) {
      return;
    }
    // Fan out every per-change dispatch in parallel — each one is an
    // independent `Workflow.findMany` + per-match enqueue, so the prior
    // sequential `await` chain was paying N round-trip latencies for no
    // ordering benefit. A bulk-tag operation that changes 5 tags and the
    // stage on one contact previously serialized into 6× the DB latency
    // before any workflow could enqueue. `Promise.all` here keeps total
    // wall-time bounded to the slowest single lookup.
    const dispatches: Array<Promise<unknown>> = [];
    for (const change of e.fieldChanges) {
      dispatches.push(
        dispatch(e.teamId, "contact_field_updated", {
          contact: e.workflowContact,
          fieldKey: change.key,
          previousValue: change.previous,
          newValue: change.next,
          changedByUserId: e.changedByUserId,
        }),
      );
    }
    if (e.previousStageId !== newStageId) {
      dispatches.push(
        dispatch(e.teamId, "contact_lifecycle_updated", {
          contact: e.workflowContact,
          previousStageId: e.previousStageId,
          newStageId,
          changedByUserId: e.changedByUserId,
        }),
      );
    }
    if (e.tagChanges) {
      for (const tagId of e.tagChanges.added) {
        dispatches.push(
          dispatch(e.teamId, "contact_tag_updated", {
            contact: e.workflowContact,
            kind: "added",
            tagId,
            changedByUserId: e.changedByUserId,
          }),
        );
      }
      for (const tagId of e.tagChanges.removed) {
        dispatches.push(
          dispatch(e.teamId, "contact_tag_updated", {
            contact: e.workflowContact,
            kind: "removed",
            tagId,
            changedByUserId: e.changedByUserId,
          }),
        );
      }
    }
    // `allSettled` so one dispatch failure (e.g. a malformed condition on
    // one workflow) does NOT abort dispatch for the rest. Each failure is
    // already logged inside `dispatch()` — the rejection here is just the
    // re-thrown error after that log.
    if (dispatches.length > 0) await Promise.allSettled(dispatches);
  });

  return () => {
    for (const off of offs) off();
  };
}
