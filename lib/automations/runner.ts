// Note: no `server-only` import — pulled in by the BullMQ worker which boots
// from server.ts, outside the Next bundler context.

import type { Prisma, AutomationTriggerEvent } from "@prisma/client";

import { db } from "@/lib/db";
import {
  parseWebhookConfig,
  runWebhookAction,
} from "@/lib/automations/actions/webhook";
import type { AutomationWebhookEnvelope } from "@/lib/automations/events";

/**
 * Per-job runner. Owns the AutomationRun lifecycle:
 *
 *   queued → running → success | failed | skipped
 *
 * Called from the BullMQ worker. The dispatcher pre-enqueues into BullMQ; the
 * worker calls back into this with the deserialized job data. We re-load the
 * Automation row each run so:
 *   - a disabled rule between dispatch and run skips cleanly
 *   - the latest actionConfig (URL/token edits) takes effect on the next job
 *
 * Throws on retryable errors (5xx, timeout). BullMQ catches and reschedules.
 */

export interface RunInput {
  automationId: string;
  teamId: string;
  trigger: AutomationTriggerEvent;
  payload: unknown;
  isTest?: boolean;
  /** BullMQ attempt number (1-indexed). Used to write `attempts` on the run row. */
  attempt: number;
}

export async function runAutomation(input: RunInput): Promise<{ runId: string; skipped: boolean }> {
  const auto = await db.automation.findUnique({
    where: { id: input.automationId },
    select: { id: true, teamId: true, enabled: true, actionType: true, actionConfig: true },
  });

  // Rule was deleted or moved to another team between dispatch and run.
  // Record a skipped run so admins can see what happened.
  if (!auto || auto.teamId !== input.teamId) {
    const skipped = await db.automationRun.create({
      data: {
        automationId: input.automationId,
        teamId: input.teamId,
        status: "skipped",
        trigger: input.trigger,
        eventPayload: input.payload as Prisma.InputJsonValue,
        attempts: input.attempt,
        errorMessage: "automation no longer exists",
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    return { runId: skipped.id, skipped: true };
  }

  if (!auto.enabled) {
    const skipped = await db.automationRun.create({
      data: {
        automationId: auto.id,
        teamId: auto.teamId,
        status: "skipped",
        trigger: input.trigger,
        eventPayload: input.payload as Prisma.InputJsonValue,
        attempts: input.attempt,
        errorMessage: "automation disabled before run",
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    return { runId: skipped.id, skipped: true };
  }

  // Mark this attempt as running. Each retry creates a NEW run row so the
  // history shows every attempt distinctly — cleaner than mutating one row.
  const run = await db.automationRun.create({
    data: {
      automationId: auto.id,
      teamId: auto.teamId,
      status: "running",
      trigger: input.trigger,
      eventPayload: input.payload as Prisma.InputJsonValue,
      attempts: input.attempt,
    },
    select: { id: true },
  });

  try {
    if (auto.actionType === "webhook") {
      const config = parseWebhookConfig(auto.actionConfig);
      const envelope = buildEnvelope(auto.teamId, input.trigger, input.payload);
      const result = await runWebhookAction(envelope, config);

      const ok = result.status >= 200 && result.status < 400;
      await db.automationRun.update({
        where: { id: run.id },
        data: {
          status: ok ? "success" : "failed",
          responseStatus: result.status,
          responseBody: result.body,
          finishedAt: new Date(),
          ...(ok ? {} : { errorMessage: `webhook returned ${result.status}` }),
        },
      });
      // 4xx is final (user config issue). Don't throw — no retry.
      return { runId: run.id, skipped: false };
    }
    throw new Error(`unsupported action type: ${auto.actionType}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.automationRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        errorMessage: msg.slice(0, 2048),
        finishedAt: new Date(),
      },
    });
    // Re-throw so BullMQ schedules a retry.
    throw err;
  }
}

function buildEnvelope(
  teamId: string,
  trigger: AutomationTriggerEvent,
  payload: unknown,
): AutomationWebhookEnvelope {
  // Extract conversation + contact ids from the payload so we can build
  // _links callback URLs. All three triggers expose `conversation.id` and
  // `contact.id`; if anything is shaped differently we fall back to "".
  const p = payload as { conversation?: { id?: string }; contact?: { id?: string } };
  const conversationId = p?.conversation?.id ?? "";
  const contactId = p?.contact?.id ?? "";
  const base = process.env.APP_PUBLIC_URL ?? "http://localhost:3000";
  return {
    version: 1,
    event: trigger,
    teamId,
    occurredAt: new Date().toISOString(),
    data: payload as AutomationWebhookEnvelope["data"],
    _links: {
      conversation: `${base}/api/external/v1/conversations/${conversationId}`,
      messages: `${base}/api/external/v1/conversations/${conversationId}/messages`,
      contact: `${base}/api/external/v1/contacts/${contactId}`,
    },
  };
}
