import "server-only";

import type { AutomationTriggerEvent } from "@prisma/client";

import { db } from "@/lib/db";
import { evaluateConditions } from "@/lib/automations/conditions";
import type { EventPayload, PayloadFor } from "@/lib/automations/events";
import { enqueueAutomation } from "@/lib/automations/queue";

/**
 * Public entry point for the automations system. Call from any place in the
 * app that produces a domain event (ingest, assign route, status route).
 *
 *   await dispatch(teamId, "message_received", { message, conversation, ... });
 *
 * Behavior:
 *   - Loads enabled automations for this team+trigger (single indexed query)
 *   - Evaluates each rule's conditions against the payload synchronously
 *   - Enqueues a BullMQ job per matching rule
 *
 * Failures during dispatch are logged but NEVER thrown — automations are
 * additive infrastructure, they must not break the primary write path. A
 * Redis outage degrades automations only; messages still ingest, replies
 * still send.
 */
export async function dispatch<E extends AutomationTriggerEvent>(
  teamId: string,
  event: E,
  payload: PayloadFor<E>,
): Promise<void> {
  try {
    const rules = await db.automation.findMany({
      where: { teamId, trigger: event, enabled: true },
      select: { id: true, conditions: true },
    });
    if (rules.length === 0) return;

    // Evaluate all rules synchronously (pure, fast), then enqueue the matches
    // in parallel. Errors from one enqueue don't take down sibling rules.
    const matched = rules.filter((r) =>
      evaluateConditions(r.conditions as unknown, payload as EventPayload),
    );
    await Promise.allSettled(
      matched.map((r) =>
        enqueueAutomation({
          automationId: r.id,
          teamId,
          trigger: event,
          payload,
        }),
      ),
    );
  } catch (err) {
    // Loud, but never throw. The fix is to bring Redis back; until then we
    // shouldn't keep webhook deliveries from Meta hitting 500.
    console.error(
      `[automations] dispatch failed for team=${teamId} event=${event}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Fire one automation synchronously for the "Test" button in the UI. Skips
 * the conditions check entirely (the user is testing the action). Returns
 * the BullMQ job id so the UI can poll the run row created by the worker.
 */
export async function dispatchTest(
  automationId: string,
  teamId: string,
  payload: EventPayload,
): Promise<string> {
  const auto = await db.automation.findFirst({
    where: { id: automationId, teamId },
    select: { id: true, trigger: true },
  });
  if (!auto) throw new Error("automation not found");
  return enqueueAutomation({
    automationId: auto.id,
    teamId,
    trigger: auto.trigger,
    payload,
    isTest: true,
  });
}
