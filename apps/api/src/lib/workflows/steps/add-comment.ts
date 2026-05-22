import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { resolveFieldTokens } from "@ccp/shared/field-tokens";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advance,
  advanceWithError,
  envelopeContact,
  envelopeConversation,
} from "./types";
import { buildTokenContext } from "./token-context";

/**
 * `add_comment` step. Drops an InternalNote on the conversation.
 *
 *   Config: { body: string }
 *
 * `body` supports `$var.contact.*` tokens. @mention parsing (resolving
 * "@alice" to userId for notification routing) is deliberately deferred
 * to Round 2c — the note is stored as plain text for now, and the inbox
 * UI already renders @-prefixed tokens as clickable mentions on read.
 *
 * authorUserId is null — system-authored notes. The UI renders them as
 * "Workflow" badge in the timeline.
 */
export interface AddCommentStepConfig {
  body: string;
}

export const addCommentStepHandler: StepHandler<AddCommentStepConfig> = {
  type: "add_comment",
  sideEffect: "irreversible",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("add_comment config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.body !== "string" || !r.body.trim()) {
      throw new StepConfigError("add_comment.body must be a non-empty string");
    }
    return { body: r.body };
  },
  describeConfig(c) {
    return `Note "${c.body.slice(0, 40)}${c.body.length > 40 ? "…" : ""}"`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    const conv = envelopeConversation(envelope);
    if (!conv) return advanceWithError(400, "envelope missing conversation");
    const conversationId = conv.id;

    const conversation = await db.conversation.findFirst({
      where: { id: conversationId, teamId: ctx.teamId },
      select: { id: true },
    });
    if (!conversation) return advanceWithError(404, "conversation not found");

    // Full trigger contact + sender so all $var.contact.* / $var.sender.*
    // tokens (incl. stage_name / tag_names / window_state) resolve.
    const { contact, extras } = await buildTokenContext(
      envelope,
      ctx,
      ctx.teamId,
      envelopeContact(envelope)?.id,
    );
    const body = resolveFieldTokens(config.body, contact, extras);

    const note = await db.internalNote.create({
      data: {
        teamId: ctx.teamId,
        conversationId,
        authorUserId: null,
        body,
      },
    });

    // Publish `note.created` — socket fanout emits the live update;
    // outbound-webhooks subscriber forwards to integrators. `silent: true`
    // mirrors every sibling mutation step's discipline: if a future
    // workflow trigger on `note_added` lands, the workflow-dispatch
    // subscriber will see this flag and skip chain-trigger dispatch on
    // system-authored notes (today no such subscriber exists, but the
    // contract is uniform so the next author doesn't have to remember
    // which event types do/don't need silent).
    await publish({
      type: "note.created",
      teamId: ctx.teamId,
      conversationId,
      note: {
        id: note.id,
        conversationId,
        authorUserId: null,
        body,
        timestamp: note.timestamp.toISOString(),
      },
      silent: true,
    });

    return advance({ noteId: note.id, conversationId });
  },
};
