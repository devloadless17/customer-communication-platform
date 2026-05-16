import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";
import type { Contact } from "@/lib/types";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advance,
  advanceWithError,
  envelopeContact,
} from "./types";

/**
 * `add_tag` and `remove_tag` steps. Connect/disconnect semantics on the
 * contact's existing tag set — both are idempotent (re-adding an existing
 * tag, removing one the contact doesn't have are no-ops, not errors).
 *
 * Tag is verified to belong to the same team. Stale config referencing a
 * deleted tag returns 404 and advances.
 */

interface TagConfig {
  tagId: string;
}

function parseTagConfig(kind: "add_tag" | "remove_tag", raw: unknown): TagConfig {
  if (!raw || typeof raw !== "object") {
    throw new StepConfigError(`${kind} config must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.tagId !== "string" || !r.tagId) {
    throw new StepConfigError(`${kind}.tagId must be a non-empty string`);
  }
  return { tagId: r.tagId };
}

async function runTagMutation(
  envelope: Parameters<StepHandler["run"]>[0],
  ctx: Parameters<StepHandler["run"]>[2],
  tagId: string,
  kind: "add" | "remove",
): Promise<StepResult> {
  const c = envelopeContact(envelope);
  if (!c) return advanceWithError(400, "envelope missing contact");
  const contactId = c.id;

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

  const updated = await db.contact.update({
    where: { id: contactId },
    data: {
      tags: kind === "add" ? { connect: { id: tag.id } } : { disconnect: { id: tag.id } },
    },
    include: { tags: { select: { id: true } } },
  });

  const payload: Contact = {
    id: updated.id,
    teamId: updated.teamId,
    phoneNumber: updated.phoneNumber,
    identityProvider: updated.identityProvider,
    externalContactId: updated.externalContactId,
    name: updated.name,
    avatarUrl: updated.avatarUrl ?? undefined,
    email: updated.email ?? undefined,
    location: updated.location ?? undefined,
    customFields: normalizeStringMap(updated.customFields),
    source: updated.source,
    stageId: updated.stageId,
    tagIds: updated.tags.map((t) => t.id),
  };
  emitToTeam(ctx.teamId, "contact:updated", { teamId: ctx.teamId, contact: payload });

  return advance({ contactId, tagId: tag.id, kind, tagIds: payload.tagIds });
}

export const addTagStepHandler: StepHandler<TagConfig> = {
  type: "add_tag",
  parseConfig: (raw) => parseTagConfig("add_tag", raw),
  describeConfig: (c) => `Add tag ${c.tagId}`,
  run: (env, c, ctx) => runTagMutation(env, ctx, c.tagId, "add"),
};

export const removeTagStepHandler: StepHandler<TagConfig> = {
  type: "remove_tag",
  parseConfig: (raw) => parseTagConfig("remove_tag", raw),
  describeConfig: (c) => `Remove tag ${c.tagId}`,
  run: (env, c, ctx) => runTagMutation(env, ctx, c.tagId, "remove"),
};

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
