import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import type { Contact } from "@ccp/shared/types";
import { type ContactLike, resolveFieldTokens } from "@ccp/shared/field-tokens";
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
      resolved = await resolveStepTarget(config.target, envelope, ctx.teamId, {
        createConversation: false,
      });
    } catch (err) {
      if (err instanceof StepConfigError) return advanceWithError(400, err.message);
      throw err;
    }
    const contactId = resolved.contactId;

    const [contact, fieldDef] = await Promise.all([
      db.contact.findFirst({
        where: { id: contactId, teamId: ctx.teamId },
        include: { tags: { select: { id: true } } },
      }),
      db.contactFieldDefinition.findFirst({
        where: { teamId: ctx.teamId, key: config.fieldKey },
        select: { key: true },
      }),
    ]);
    if (!contact) return advanceWithError(404, "contact not found");
    if (!fieldDef) {
      return advanceWithError(404, "field_key_not_defined", `No ContactFieldDefinition with key "${config.fieldKey}"`);
    }

    const contactLike: ContactLike = {
      name: contact.name,
      phoneNumber: contact.phoneNumber,
      email: contact.email,
      location: contact.location,
      customFields: normalizeStringMap(contact.customFields),
    };
    const resolvedValue = resolveFieldTokens(config.value, contactLike);

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
        where: { id: contactId, teamId: ctx.teamId, version: contact.version },
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

    const payload: Contact = {
      id: updated.id,
      teamId: updated.teamId,
      phoneNumber: updated.phoneNumber,
      identityChannel: updated.identityChannel,
      externalContactId: updated.externalContactId,
      name: updated.name,
      firstName: updated.firstName,
      lastName: updated.lastName,
      language: updated.language,
      countryCode: updated.countryCode,
      avatarUrl: updated.avatarUrl ?? undefined,
      email: updated.email ?? undefined,
      location: updated.location ?? undefined,
      customFields: nextFields,
      source: updated.source,
      stageId: updated.stageId,
      tagIds: updated.tags.map((t) => t.id),
      createdAt: updated.createdAt.toISOString(),
    };

    // `silent: true` — step-driven mutations don't re-trigger workflows.
    // The fieldChanges list still carries the diff so future subscribers
    // (e.g. outbound webhooks) can see what changed.
    await publish({
      type: "contact.updated",
      teamId: ctx.teamId,
      contact: payload,
      previousStageId: updated.stageId, // stage didn't change here
      fieldChanges: [{ key: config.fieldKey, previous: previousValue, next: resolvedValue }],
      changedByUserId: null,
      workflowContact: workflowContactSnapshot(updated),
      silent: true,
    });

    return advance({
      contactId,
      fieldKey: config.fieldKey,
      previousValue,
      newValue: resolvedValue,
    });
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
