import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import type { DomainEventOf } from "@ccp/shared/events/types";

import { assignByPolicy } from "@/lib/assignment/apply";
import { loadAssignmentSettings } from "@/lib/assignment/resolve";
import { legacyAutopilotOwnsTeam } from "@/lib/ai/automation-claim";
import { getState } from "@/lib/ai/conversation-state";
import { aiTextEngineConfigured } from "@/lib/ai/models";
import { configEnabled, loadAiConfig } from "@/lib/ai/runtime-config";
import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { subscribe, SubscriberPriority } from "@/lib/events/bus";

/**
 * Automatic conversation routing on inbound.
 *
 * This is the surface the AI-first support floors actually run on: a customer
 * message lands, and either the AI takes it (and a human is routed in later,
 * on escalation) or a human is routed in immediately.
 *
 * Two triggers, both OFF by default (`AssignmentSettings`):
 *
 *   autoAssignOnNewConversation — the first inbound of a brand-new thread.
 *   autoAssignOnReopen          — a new inbound on an EXISTING thread that has
 *                                 no owner (reopened after close, or one a
 *                                 human deliberately unassigned).
 *
 * `skipWhenAiHandling` (default ON) is the "AI first" switch: while the
 * assistant is actively handling the thread, we do NOT burn a human's capacity
 * on it. The human arrives when the AI escalates (orchestrator → assignByPolicy
 * with source `ai_handoff`) or when an agent claims it. Turning it off gives
 * every conversation a named owner from message one, even while the AI answers
 * — some orgs want that for accountability.
 *
 * PRIORITY. Registered between ANALYTICS (20) and WORKFLOW_DISPATCH (30) so:
 *   - the analytics counters this event drives are already written, and
 *   - a `message_received` workflow, and any `conversation_assigned` workflow,
 *     both observe the routing decision instead of racing it.
 *
 * SAFETY. Every guard that matters is inside `assignByPolicy`:
 * `onlyIfUnassigned` means a redelivered webhook, a duplicate event or a burst
 * of inbounds on one thread can only ever fill an EMPTY assignee slot — so this
 * subscriber is idempotent by construction and can never take a conversation
 * away from the agent working it.
 */
@Injectable()
export class AutoAssignSubscriber implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoAssignSubscriber.name);
  private offs: Array<() => void> = [];
  private registered = false;

  onModuleInit(): void {
    if (this.registered) return;
    this.registered = true;
    this.offs.push(
      subscribe(
        "message.received",
        // AWAITED (2026-07-27). This used to be `void this.onReceived(e)`,
        // which returned synchronously — so the bus moved straight on to
        // WORKFLOW_DISPATCH while routing was still resolving, and the tier-25
        // ordering this subscriber exists for was fiction: a `message_received`
        // workflow RACED the routing decision instead of observing it. The
        // try/catch keeps the "never throw into the bus" posture, while the
        // await also brings this handler back inside the per-subscriber
        // timeout, the outbox `lastError` sink, and the at-least-once lease.
        async (e) => {
          try {
            await this.onReceived(e);
          } catch (err) {
            this.logError(err);
          }
        },
        // Between ANALYTICS (20) and WORKFLOW_DISPATCH (30).
        SubscriberPriority.ANALYTICS + 5,
      ),
    );
  }

  onModuleDestroy(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  private async onReceived(e: DomainEventOf<"message.received">): Promise<void> {
    if (e.silent) return;
    if (e.message?.direction !== "in") return;

    // The event snapshot already carries the assignee — skip the settings read
    // entirely for the overwhelming majority of inbounds, which land on threads
    // that already have an owner.
    if (e.conversation?.assignedUserId) return;

    const settings = await loadAssignmentSettings(db, e.workspaceId);
    const wanted = e.isNewConversation
      ? settings.autoAssignOnNewConversation
      : settings.autoAssignOnReopen;
    if (!wanted) {
      // Logged, not silent: "I turned auto-assign on and nothing happens" is
      // the single most likely support question about this feature, and the
      // answer is almost always that the OTHER trigger is the one that applies
      // (a reopened thread is not a new conversation). Saying which flag was
      // read, and what it was, answers it without a debugging session.
      this.logger.debug(
        `auto-assign disabled for this trigger: conversation=${e.conversationId} ` +
          `isNew=${e.isNewConversation} onNew=${settings.autoAssignOnNewConversation} ` +
          `onReopen=${settings.autoAssignOnReopen}`,
      );
      return;
    }

    if (settings.skipWhenAiHandling && (await this.aiWillHandle(e.workspaceId, e.conversationId))) {
      this.logger.debug(
        `auto-assign deferred to the AI: conversation=${e.conversationId}`,
      );
      return;
    }

    const outcome = await assignByPolicy({
      db,
      publish,
      workspaceId: e.workspaceId,
      conversationId: e.conversationId,
      source: e.isNewConversation ? "inbound" : "reopen",
      context: {
        messageText: e.message.body ?? null,
        channel: e.message.channel,
        tagIds: e.contact?.tagIds ?? [],
        stageId: e.contact?.stageId ?? null,
        language: e.contact?.language ?? null,
        isNewContact: e.isNewConversation,
      },
      onlyIfUnassigned: true,
      changedByUserId: null,
    });

    if (!outcome.applied) {
      // "Why is nothing being assigned?" must be answerable from the log alone.
      // `no_assignee` is an expected, configured outcome (everyone offline or
      // at capacity) and stays at debug so a busy night doesn't spam. The rest
      // mean routing was attempted and lost — `exhausted` in particular means
      // every candidate failed validation, which is a misconfiguration worth
      // seeing, and `lost_race` means someone else claimed it mid-flight.
      const detail = `conversation=${e.conversationId} skipped=${outcome.skipped} reason=${outcome.decision?.reason ?? "n/a"} policy=${outcome.decision?.policyName ?? "n/a"}`;
      if (outcome.skipped === "no_assignee" || outcome.skipped === "already_assigned") {
        this.logger.debug(`auto-assign no-op: ${detail}`);
      } else {
        this.logger.warn(`auto-assign did not assign: ${detail}`);
      }
    }
  }

  /**
   * Is the built-in assistant going to answer this inbound?
   *
   * Deliberately mirrors the gates in `AiReplySubscriber.onReceived` +
   * `orchestrator`, in the same order and cheapest-first. It is a HINT, not a
   * lock: if it guesses wrong and we skip, the conversation simply stays in the
   * triage queue until the AI escalates or an agent claims it — never lost. The
   * opposite error (assigning a thread the AI then handles end-to-end) is the
   * one that wastes an agent's capacity, so the check is biased toward skipping.
   */
  private async aiWillHandle(workspaceId: string, conversationId: string): Promise<boolean> {
    // The legacy n8n autopilot stands the native assistant down entirely for the
    // team, and answers the conversation itself — so it counts as "AI handling"
    // even though none of the native gates below would fire.
    if (await legacyAutopilotOwnsTeam(workspaceId)) return true;
    if (!aiTextEngineConfigured()) return false;
    const config = await loadAiConfig(workspaceId);
    if (!configEnabled(config)) return false;
    const state = await getState(conversationId);
    // No row yet = a brand-new thread the assistant hasn't touched → it will.
    if (!state) return true;
    return state.state === "ai_active";
  }

  private logError(err: unknown): void {
    this.logger.error(
      `auto-assign subscriber failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
