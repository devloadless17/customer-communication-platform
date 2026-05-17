import {
  SendTextValidationError,
  sendTextInternal,
} from "@/lib/messaging/send-text-internal";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import { type ContactLike, resolveFieldTokens } from "@ccp/shared/field-tokens";

import {
  type StepHandler,
  type StepResult,
  StepConfigError,
  advance,
  advanceWithError,
  envelopeContact,
  envelopeConversation,
  truncateBody,
} from "./types";

/**
 * `send_message` step. Sends a free-form text via the team's provider.
 *
 *   Config: { body: string }
 *
 * `body` supports `$var.contact.*` tokens. Outside-of-24h-window returns 422
 * and advances — workflow authors who need cold reachout should use a
 * `send_template` step instead.
 */
export interface SendMessageStepConfig {
  body: string;
}

export const sendMessageStepHandler: StepHandler<SendMessageStepConfig> = {
  type: "send_message",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("send_message config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.body !== "string" || !r.body.trim()) {
      throw new StepConfigError("send_message.body must be a non-empty string");
    }
    return { body: r.body };
  },
  describeConfig(config) {
    return `Send "${config.body.slice(0, 40)}${config.body.length > 40 ? "…" : ""}"`;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    const conv = envelopeConversation(envelope);
    if (!conv) return advanceWithError(400, "envelope missing conversation");
    const conversationId = conv.id;
    const c = envelopeContact(envelope);
    const contact: ContactLike = {
      name: c?.name ?? "",
      phoneNumber: c?.phoneNumber ?? null,
      email: c?.email ?? null,
      location: null,
      customFields: c?.customFields ?? {},
    };
    const body = resolveFieldTokens(config.body, contact);

    try {
      const result = await sendTextInternal({
        teamId: ctx.teamId,
        conversationId,
        body,
        sentVia: `workflow/${ctx.workflowId}`,
      });
      return advance({ messageId: result.messageId, externalId: result.externalId });
    } catch (err) {
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
