import { db } from "@/lib/db";
import {
  SendTextValidationError,
  sendTextInternal,
} from "@/lib/messaging/send-text-internal";
import {
  ConversationSendRateLimitedError,
  consumeConversationSendBudget,
} from "@/lib/messaging/conversation-send-budget";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import { type ContactLike, resolveFieldTokens } from "@ccp/shared/field-tokens";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advance,
  advanceWithError,
  envelopeContact,
  envelopeExtras,
  truncateBody,
} from "./types";
import {
  type StepTarget,
  parseStepTarget,
  resolveStepTarget,
} from "./target";

/**
 * `send_message` step. Sends a free-form text via the team's provider.
 *
 *   Config: { body: string, target?: StepTarget }
 *
 * `body` supports `$var.contact.*` tokens. Outside-of-24h-window returns 422
 * and advances — workflow authors who need cold reachout should use a
 * `send_template` step instead.
 *
 * `target` picks who to send to:
 *   - undefined / trigger_contact (default) → the contact the trigger fired
 *     for. Existing behavior.
 *   - phone → an arbitrary E.164 number. Auto-creates Contact + open
 *     Conversation if they don't exist yet. The 24h window still applies —
 *     if the target's last inbound is >24h or never, this step returns 422
 *     (use `send_template` for cold reachout).
 */
export interface SendMessageStepConfig {
  body: string;
  target?: StepTarget;
}

export const sendMessageStepHandler: StepHandler<SendMessageStepConfig> = {
  type: "send_message",
  sideEffect: "irreversible",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("send_message config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.body !== "string" || !r.body.trim()) {
      throw new StepConfigError("send_message.body must be a non-empty string");
    }
    const target = parseStepTarget(r.target);
    return target ? { body: r.body, target } : { body: r.body };
  },
  describeConfig(config) {
    const head = `Send "${config.body.slice(0, 40)}${config.body.length > 40 ? "…" : ""}"`;
    if (config.target && config.target.kind === "phone") {
      return `${head} → ${config.target.phoneNumber}`;
    }
    return head;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    let resolved;
    try {
      resolved = await resolveStepTarget(config.target, envelope, ctx.teamId, {
        createConversation: true,
      });
    } catch (err) {
      if (err instanceof StepConfigError) {
        return advanceWithError(400, err.message);
      }
      throw err;
    }
    if (!resolved.conversationId) {
      return advanceWithError(400, "could not resolve a conversation for the target");
    }
    const conversationId = resolved.conversationId;
    // For the trigger-contact path we already have the contact snapshot.
    // For the phone path we need to read the contact row so $var.contact.*
    // tokens resolve against the TARGET (not the trigger contact).
    let contact: ContactLike;
    if (!config.target || config.target.kind === "trigger_contact") {
      const c = envelopeContact(envelope);
      contact = {
        name: c?.name ?? "",
        phoneNumber: c?.phoneNumber ?? null,
        email: c?.email ?? null,
        location: null,
        customFields: c?.customFields ?? {},
      };
    } else {
      const row = await db.contact.findFirst({
        where: { id: resolved.contactId, teamId: ctx.teamId },
        select: {
          name: true,
          phoneNumber: true,
          email: true,
          location: true,
          customFields: true,
        },
      });
      contact = {
        name: row?.name ?? "",
        phoneNumber: row?.phoneNumber ?? null,
        email: row?.email ?? null,
        location: row?.location ?? null,
        customFields: (row?.customFields as Record<string, string> | null) ?? {},
      };
    }
    // Pass envelope message + conversation through as `extras` so authors
    // can drop `$var.message.body`, `$var.message.timestamp`, etc. inline.
    // Falls back to empty string for tokens whose source isn't in this
    // trigger's payload (e.g. `$var.message.*` outside message_received).
    const body = resolveFieldTokens(config.body, contact, envelopeExtras(envelope));

    try {
      // Per-conversation send ceiling — the loop backstop for workflow auto-
      // replies (the unmetered leg flagged in the 2026-05-22 audit). A runaway
      // automation hammering one thread records a clean 429 and advances
      // instead of spending unbounded customer-facing Meta sends.
      consumeConversationSendBudget(ctx.teamId, conversationId);
      const result = await sendTextInternal({
        teamId: ctx.teamId,
        conversationId,
        body,
        sentVia: `workflow/${ctx.workflowId}`,
      });
      return advance({ messageId: result.messageId, externalId: result.externalId });
    } catch (err) {
      if (err instanceof ConversationSendRateLimitedError) {
        return advanceWithError(429, "conversation_send_rate_limited", err.message);
      }
      if (err instanceof SendTextValidationError) {
        return {
          kind: "advance",
          status: 422,
          body: truncateBody(JSON.stringify({ error: err.code, detail: err.detail })),
        };
      }
      const normalized = normalizeMetaSendError(err);
      if (normalized) {
        return {
          kind: "advance",
          status: 422,
          body: truncateBody(
            JSON.stringify({ error: normalized.code, message: normalized.message }),
          ),
        };
      }
      throw err;
    }
  },
};
