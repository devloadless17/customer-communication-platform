import {
  SendTextValidationError,
  sendTextInternal,
} from "@/lib/messaging/send-text-internal";
import {
  ConversationSendRateLimitedError,
  consumeConversationSendBudget,
} from "@/lib/messaging/conversation-send-budget";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import { resolveFieldTokens } from "@ccp/shared/field-tokens";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advance,
  advanceWithError,
  truncateBody,
} from "./types";
import {
  type StepTarget,
  parseStepTarget,
  resolveStepTarget,
} from "./target";
import { buildTokenContext } from "./token-context";

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
  /**
   * Which of the workspace's accounts to send FROM when this step has to OPEN
   * a conversation. An existing thread always keeps its own account — moving a
   * live thread to another number mid-flight would reach the customer from a
   * sender they never messaged. Absent = the channel's default, which is the
   * pre-existing behaviour.
   */
  accountId?: string;
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
    const accountId = typeof r.accountId === "string" && r.accountId ? r.accountId : undefined;
    return {
      body: r.body,
      ...(target ? { target } : {}),
      ...(accountId ? { accountId } : {}),
    };
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
      resolved = await resolveStepTarget(config.target, envelope, ctx.workspaceId, {
        createConversation: true,
        // Only used when the step OPENS a thread. An existing conversation
        // keeps its own account — a workflow must never move a live thread to
        // a different number mid-flight.
        accountId: config.accountId,
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
    // Load the resolution contact (the send target — custom phone or, by
    // default, the trigger contact) AND the original trigger sender COMPLETE,
    // so every $var.contact.* / $var.sender.* token resolves, including the
    // derived stage_name / tag_names / window_state / last_inbound_at. Also
    // carries $var.message.* / $var.previousStep.* via extras.
    const { contact, extras } = await buildTokenContext(
      envelope,
      ctx,
      ctx.workspaceId,
      resolved.contactId,
    );
    const body = resolveFieldTokens(config.body, contact, extras);

    try {
      // Per-conversation send ceiling — the loop backstop for workflow auto-
      // replies (the unmetered leg flagged in the 2026-05-22 audit). A runaway
      // automation hammering one thread records a clean 429 and advances
      // instead of spending unbounded customer-facing Meta sends.
      consumeConversationSendBudget(ctx.workspaceId, conversationId);
      const result = await sendTextInternal({
        workspaceId: ctx.workspaceId,
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
