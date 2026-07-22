import { normalizeStringMap } from "@/lib/normalize-string-map";
import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import type { Contact } from "@ccp/shared/types";
import { resolveFieldTokens } from "@ccp/shared/field-tokens";
import { toContactWire } from "@/lib/queries/_shared";
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
import { buildTokenContext } from "./token-context";

/**
 * `update_field` step. Sets a single custom field on the contact.
 *
 *   Config: { fieldKey: string, value: string, target?: StepTarget }
 *
 * `value` supports `$var.contact.*` tokens. `target` defaults to the
 * trigger contact; can be set to a custom phone (auto-creates Contact if
 * unknown). fieldKey is validated against the team's ContactFieldDefinition
 * rows so unknown keys fail fast.
 */
export interface UpdateFieldStepConfig {
  fieldKey: string;
  value: string;
  target?: StepTarget;
}

export const updateFieldStepHandler: StepHandler<UpdateFieldStepConfig> = {
  type: "update_field",
  sideEffect: "irreversible",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("update_field config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.fieldKey !== "string" || !r.fieldKey) {
      throw new StepConfigError("update_field.fieldKey must be a non-empty string");
    }
    if (typeof r.value !== "string") {
      throw new StepConfigError("update_field.value must be a string");
    }
    const target = parseStepTarget(r.target);
    return target
      ? { fieldKey: r.fieldKey, value: r.value, target }
      : { fieldKey: r.fieldKey, value: r.value };
  },
  describeConfig(c) {
    return `Set ${c.fieldKey} = "${c.value.slice(0, 24)}${c.value.length > 24 ? "…" : ""}"`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    let resolved;
    try {
      resolved = await resolveStepTarget(config.target, envelope, ctx.workspaceId, {
        createConversation: false,
      });
    } catch (err) {
      if (err instanceof StepConfigError) return advanceWithError(400, err.message);
      throw err;
    }
    const contactId = resolved.contactId;

    const [contact, fieldDef] = await Promise.all([
      db.contact.findFirst({
        where: { id: contactId, workspaceId: ctx.workspaceId },
        include: { tags: { select: { id: true } } },
      }),
      db.contactFieldDefinition.findFirst({
        where: { workspaceId: ctx.workspaceId, key: config.fieldKey },
        select: { key: true },
      }),
    ]);
    if (!contact) return advanceWithError(404, "contact not found");
    if (!fieldDef) {
      return advanceWithError(404, "field_key_not_defined", `No ContactFieldDefinition with key "${config.fieldKey}"`);
    }

    // Full token context: contactLike = the TARGET (custom-phone or trigger
    // contact) loaded complete; extras.triggerContact = the original sender.
    // So $var.contact.* (incl. stage_name / tag_names) AND $var.sender.* both
    // resolve — e.g. "set B's field = the sender's phone".
    const { contact: contactLike, extras } = await buildTokenContext(
      envelope,
      ctx,
      ctx.workspaceId,
      contactId,
    );
    const resolvedValue = resolveFieldTokens(config.value, contactLike, extras);

    const currentFields = normalizeStringMap(contact.customFields);
    const previousValue = currentFields[config.fieldKey] ?? null;
    if (previousValue === resolvedValue) {
      return advance({ skipped: "field_unchanged" });
    }
    const nextFields = { ...currentFields, [config.fieldKey]: resolvedValue };

    // CAS on `version`. If a user PATCH on the same contact lands between
    // our read and write, the loser surfaces as P2025 → workflow step
    // error (advanceWithError) instead of silently overwriting. Workflow
    // runs can be retried by the operator; the user's edit is preserved.
    let updated;
    try {
      updated = await db.contact.update({
        where: { id: contactId, workspaceId: ctx.workspaceId, version: contact.version },
        data: {
          customFields: nextFields as Prisma.InputJsonValue,
          version: { increment: 1 },
        },
        include: { tags: { select: { id: true } } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return advanceWithError(409, "contact modified mid-step, retry the run");
      }
      throw err;
    }

    const payload: Contact = toContactWire(updated, {
      tagIds: updated.tags.map((t) => t.id),
    });

    // `silent: true` — step-driven mutations don't re-trigger workflows (loop
    // safety). `skipOutboundWebhook: false` so partners subscribed to
    // `contact.updated` DO receive the step-driven field change — a workflow
    // moving a contact's custom field is exactly the pipeline signal an
    // n8n/CRM flow wants. Mirrors tag.ts / update-lifecycle.ts; the /v1-echo
    // case stays undelivered because it publishes `silent` with the flag unset.
    await publish({
      type: "contact.updated",
      workspaceId: ctx.workspaceId,
      contact: payload,
      previousStageId: updated.stageId, // stage didn't change here
      fieldChanges: [{ key: config.fieldKey, previous: previousValue, next: resolvedValue }],
      changedByUserId: null,
      workflowContact: workflowContactSnapshot(updated),
      silent: true,
      skipOutboundWebhook: false,
    });

    return advance({
      contactId,
      fieldKey: config.fieldKey,
      previousValue,
      newValue: resolvedValue,
    });
  },
};

