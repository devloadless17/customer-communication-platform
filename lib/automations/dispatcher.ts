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
    // Pg blip → retry once after 200ms before giving up on this event.
    // Findmany is the cheap side; if it stays down past two attempts the
    // database is the real fire, not us.
    const rules = await retry(
      () =>
        db.automation.findMany({
          where: { teamId, trigger: event, enabled: true },
          select: { id: true, conditions: true },
        }),
      RULE_LOOKUP_RETRIES,
      `[automations] rule lookup team=${teamId} event=${event}`,
    );
    if (rules.length === 0) return;

    // Evaluate all rules synchronously (pure, fast), then enqueue the matches
    // in parallel. Errors from one enqueue don't take down sibling rules.
    const matched = rules.filter((r) =>
      evaluateConditions(r.conditions as unknown, payload as EventPayload),
    );
    // Each enqueue gets its own retry — a transient Redis blip would
    // otherwise drop EVERY matched rule's run, even though the next
    // millisecond's reconnect would have worked. allSettled ensures one
    // rule's permanent failure doesn't shadow successful sibling enqueues.
    const results = await Promise.allSettled(
      matched.map((r) =>
        retry(
          () =>
            enqueueAutomation({
              automationId: r.id,
              teamId,
              trigger: event,
              payload,
            }),
          ENQUEUE_RETRIES,
          `[automations] enqueue team=${teamId} event=${event} automation=${r.id}`,
        ),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === "rejected") {
        // After ENQUEUE_RETRIES.length attempts this rule's run is durably
        // lost. Log per-rule so ops can correlate to a specific automation
        // and event, not just "something failed."
        console.error(
          `[automations] enqueue PERMANENTLY FAILED for automation=${matched[i]!.id} team=${teamId} event=${event} — run will NOT execute:`,
          result.reason instanceof Error ? result.reason.message : result.reason,
        );
      }
    }
  } catch (err) {
    // Loud, but never throw. The fix is to bring Redis back; until then we
    // shouldn't keep webhook deliveries from Meta hitting 500.
    console.error(
      `[automations] dispatch failed for team=${teamId} event=${event}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

const RULE_LOOKUP_RETRIES = [200] as const;
const ENQUEUE_RETRIES = [200, 1000, 5000] as const;

/**
 * Retry-with-backoff helper local to the dispatcher. Each entry in `delays`
 * is the delay BEFORE the next retry, so `[200, 1000, 5000]` = 4 total
 * attempts (initial + 3 retries) with backoff 200ms / 1s / 5s. On success
 * after retries, emits a recovery log so a flap shows up in ops without
 * being silent.
 */
async function retry<T>(
  fn: () => Promise<T>,
  delays: readonly number[],
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0) {
        console.warn(
          `${label} recovered after ${attempt} retr${attempt === 1 ? "y" : "ies"}`,
        );
      }
      return result;
    } catch (err) {
      lastErr = err;
      const delay = delays[attempt];
      if (delay === undefined) break;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
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
