import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import type { Contact } from "@ccp/shared/types";
import { workflowContactSnapshot } from "@/lib/workflows/events";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advance,
  advanceWithError,
} from "./types";
import {
  type StepTarget,
  parseStepTarget,
  resolveStepTarget,
} from "./target";

/**
 * `update_lifecycle` step. Moves the contact to a different ContactStage.
 *
 *   Config: { stageId: string, target?: StepTarget }   — target stage; must belong to this team
 *
 * Idempotent (no-op if already in the target stage). `target` defaults to
 * the trigger contact; can be set to a custom phone (auto-creates Contact
 * if unknown). No conversation is needed — Contact-level mutation only.
 */
export interface UpdateLifecycleStepConfig {
  stageId: string;
  target?: StepTarget;
}

export const updateLifecycleStepHandler: StepHandler<UpdateLifecycleStepConfig> = {
  type: "update_lifecycle",
  sideEffect: "irreversible",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("update_lifecycle config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.stageId !== "string" || !r.stageId) {
      throw new StepConfigError("update_lifecycle.stageId must be a non-empty string");
    }
    const target = parseStepTarget(r.target);
    return target ? { stageId: r.stageId, target } : { stageId: r.stageId };
  },
  describeConfig(c) {
    return `Move to stage ${c.stageId}`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    let resolved;
    try {
      resolved = await resolveStepTarget(config.target, envelope, ctx.teamId, {
        createConversation: false,
      });
    } catch (err) {
      if (err instanceof StepConfigError) return advanceWithError(400, err.message);
      throw err;
    }
    const contactId = resolved.contactId;

    const [contact, stage] = await Promise.all([
      db.contact.findFirst({
        where: { id: contactId, teamId: ctx.teamId },
        include: { tags: { select: { id: true } } },
      }),
      db.contactStage.findFirst({
        where: { id: config.stageId, teamId: ctx.teamId },
        select: { id: true },
      }),
    ]);
    if (!contact) return advanceWithError(404, "contact not found");
    if (!stage) return advanceWithError(404, "configured stage not in team");
    if (contact.stageId === stage.id) return advance({ skipped: "already_in_stage" });

    const previousStageId = contact.stageId;
    // CAS on `version`. Concurrent user PATCH editing a different field
    // would otherwise race read-modify-write here and lose one set. The
    // loser surfaces as advanceWithError so the workflow log shows the
    // conflict.
    let updated;
    try {
      updated = await db.contact.update({
        where: { id: contactId, teamId: ctx.teamId, version: contact.version },
        data: { stageId: stage.id, version: { increment: 1 } },
        include: { tags: { select: { id: true } } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return advanceWithError(409, "contact modified mid-step, retry the run");
      }
      throw err;
    }

    const payload: Contact = {
      id: updated.id,
      teamId: updated.teamId,
      phoneNumber: updated.phoneNumber,
      identityProvider: updated.identityProvider,
      externalContactId: updated.externalContactId,
      name: updated.name,
      firstName: updated.firstName,
      lastName: updated.lastName,
      language: updated.language,
      countryCode: updated.countryCode,
      assignedUserId: updated.assignedUserId,
      avatarUrl: updated.avatarUrl ?? undefined,
      email: updated.email ?? undefined,
      location: updated.location ?? undefined,
      customFields: normalizeStringMap(updated.customFields),
      source: updated.source,
      stageId: updated.stageId,
      tagIds: updated.tags.map((t) => t.id),
      createdAt: updated.createdAt.toISOString(),
    };

    // `silent: true` — step-driven stage change. Without this, workflow-
    // dispatch would fire `contact_lifecycle_updated` and the next workflow
    // could change the stage again → infinite loop. Use `trigger_workflow`
    // step if explicit chaining is wanted.
    await publish({
      type: "contact.updated",
      teamId: ctx.teamId,
      contact: payload,
      previousStageId,
      fieldChanges: [],
      changedByUserId: null,
      workflowContact: workflowContactSnapshot(updated),
      silent: true,
    });
    // Also fire the narrow `contact.lifecycle_changed` for outbound webhooks.
    // Workflow-dispatch reads `silent` on the catch-all event (above) to skip
    // chain-triggering; the outbound-webhook subscriber doesn't read `silent`
    // because partners DO want to know the stage just moved — that's literally
    // why they subscribed. n8n flows can decide what to do with the signal.
    await publish({
      type: "contact.lifecycle_changed",
      teamId: ctx.teamId,
      contactId: updated.id,
      before: { stageId: previousStageId },
      after: { stageId: updated.stageId },
      changedByUserId: null,
    });

    return advance({ contactId, previousStageId, newStageId: stage.id });
  },
};

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
