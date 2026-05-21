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
 * `add_tag` and `remove_tag` steps. Connect/disconnect semantics on the
 * contact's existing tag set — both are idempotent (re-adding an existing
 * tag, removing one the contact doesn't have are no-ops, not errors).
 *
 * Tag is verified to belong to the same team. Stale config referencing a
 * deleted tag returns 404 and advances.
 *
 * `target` defaults to the trigger contact; can be set to a custom phone
 * (auto-creates Contact if unknown). No conversation needed.
 */

interface TagConfig {
  tagId: string;
  target?: StepTarget;
}

function parseTagConfig(kind: "add_tag" | "remove_tag", raw: unknown): TagConfig {
  if (!raw || typeof raw !== "object") {
    throw new StepConfigError(`${kind} config must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.tagId !== "string" || !r.tagId) {
    throw new StepConfigError(`${kind}.tagId must be a non-empty string`);
  }
  const target = parseStepTarget(r.target);
  return target ? { tagId: r.tagId, target } : { tagId: r.tagId };
}

async function runTagMutation(
  envelope: Parameters<StepHandler["run"]>[0],
  ctx: Parameters<StepHandler["run"]>[2],
  cfg: TagConfig,
  kind: "add" | "remove",
): Promise<StepResult> {
  let resolved;
  try {
    resolved = await resolveStepTarget(cfg.target, envelope, ctx.teamId, {
      createConversation: false,
    });
  } catch (err) {
    if (err instanceof StepConfigError) return advanceWithError(400, err.message);
    throw err;
  }
  const contactId = resolved.contactId;
  const tagId = cfg.tagId;

  const [contact, tag] = await Promise.all([
    db.contact.findFirst({
      where: { id: contactId, teamId: ctx.teamId },
      include: { tags: { select: { id: true } } },
    }),
    db.tag.findFirst({
      where: { id: tagId, teamId: ctx.teamId },
      select: { id: true },
    }),
  ]);
  if (!contact) return advanceWithError(404, "contact not found");
  if (!tag) return advanceWithError(404, "configured tag not in team");

  const has = contact.tags.some((t) => t.id === tag.id);
  if (kind === "add" && has) return advance({ skipped: "already_tagged" });
  if (kind === "remove" && !has) return advance({ skipped: "not_tagged" });

  // CAS on `version`. Same rationale as update-field / update-lifecycle:
  // a concurrent user edit must not race-lose its changes to this step.
  let updated;
  try {
    updated = await db.contact.update({
      where: { id: contactId, teamId: ctx.teamId, version: contact.version },
      data: {
        tags: kind === "add" ? { connect: { id: tag.id } } : { disconnect: { id: tag.id } },
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

  const newTagIds = updated.tags.map((t) => t.id);
  const previousTagIds =
    kind === "add"
      ? newTagIds.filter((id) => id !== tag.id)
      : [...newTagIds, tag.id];

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
    avatarUrl: updated.avatarUrl ?? undefined,
    email: updated.email ?? undefined,
    location: updated.location ?? undefined,
    customFields: normalizeStringMap(updated.customFields),
    source: updated.source,
    stageId: updated.stageId,
    tagIds: newTagIds,
    createdAt: updated.createdAt.toISOString(),
  };

  // `silent: true` so workflow-dispatch skips chain-trigger — a step inside
  // workflow X must not trigger workflow Y mid-run (loop avoidance). Use the
  // `trigger_workflow` step if you want explicit chaining. Socket fanout,
  // audit, and analytics still run normally.
  await publish({
    type: "contact.updated",
    teamId: ctx.teamId,
    contact: payload,
    previousStageId: updated.stageId, // stage didn't change here
    fieldChanges: [],
    changedByUserId: null,
    workflowContact: workflowContactSnapshot(updated),
    silent: true,
  });
  // Narrow event for outbound webhooks. Same rationale as update-lifecycle.ts:
  // workflow-dispatch reads `silent` on the catch-all to skip chain triggers;
  // the outbound-webhook subscriber doesn't — partners subscribed to
  // "On Contact Tag updated" want to see step-driven changes too.
  await publish({
    type: "contact.tag_changed",
    teamId: ctx.teamId,
    contactId: updated.id,
    before: { tagIds: previousTagIds },
    after: { tagIds: newTagIds },
    added: kind === "add" ? [tag.id] : [],
    removed: kind === "remove" ? [tag.id] : [],
    changedByUserId: null,
    // Defensive — workflow-dispatch doesn't subscribe to this event
    // today, but the day someone wires the "On Contact Tag updated"
    // trigger they MUST honor `silent` or this step infinite-loops into
    // itself. Mirrors the catch-all `contact.updated` publish above.
    silent: true,
  });

  return advance({ contactId, tagId: tag.id, kind, tagIds: payload.tagIds });
}

export const addTagStepHandler: StepHandler<TagConfig> = {
  type: "add_tag",
  sideEffect: "irreversible",
  parseConfig: (raw) => parseTagConfig("add_tag", raw),
  describeConfig: (c) => `Add tag ${c.tagId}`,
  run: (env, c, ctx) => runTagMutation(env, ctx, c, "add"),
};

export const removeTagStepHandler: StepHandler<TagConfig> = {
  type: "remove_tag",
  sideEffect: "irreversible",
  parseConfig: (raw) => parseTagConfig("remove_tag", raw),
  describeConfig: (c) => `Remove tag ${c.tagId}`,
  run: (env, c, ctx) => runTagMutation(env, ctx, c, "remove"),
};

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
