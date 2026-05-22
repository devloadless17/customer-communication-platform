import {
  SendTemplateValidationError,
  sendTemplateInternal,
} from "@/lib/messaging/send-template-internal";
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
  envelopeConversation,
  envelopeExtras,
  truncateBody,
} from "./types";

export interface SendTemplateStepConfig {
  templateId: string;
  variables: {
    body: string[];
    header?: string;
  };
}

export const sendTemplateStepHandler: StepHandler<SendTemplateStepConfig> = {
  type: "send_template",
  sideEffect: "irreversible",
  parseConfig(raw) {
    if (!raw || typeof raw !== "object") {
      throw new StepConfigError("send_template config must be an object");
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.templateId !== "string" || !r.templateId) {
      throw new StepConfigError("send_template.templateId must be a non-empty string");
    }
    const vars = r.variables;
    if (!vars || typeof vars !== "object") {
      throw new StepConfigError("send_template.variables must be an object");
    }
    const v = vars as Record<string, unknown>;
    const bodyArr = Array.isArray(v.body) ? v.body : [];
    const body: string[] = [];
    for (const x of bodyArr) {
      if (typeof x !== "string") {
        throw new StepConfigError("send_template.variables.body must be string[]");
      }
      body.push(x);
    }
    const header = typeof v.header === "string" && v.header.length > 0 ? v.header : undefined;
    return {
      templateId: r.templateId,
      variables: { body, ...(header ? { header } : {}) },
    };
  },
  describeConfig(config) {
    return `Send template ${config.templateId}`;
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
    const extras = envelopeExtras(envelope);
    const variables = {
      body: config.variables.body.map((v) => resolveFieldTokens(v, contact, extras)),
      ...(config.variables.header
        ? { header: resolveFieldTokens(config.variables.header, contact, extras) }
        : {}),
    };

    try {
      // Per-conversation send ceiling — same loop backstop as send_message.
      // Templates are billed cold-outbound, so a runaway template loop is the
      // most expensive variant; cap it per thread before reaching Meta.
      consumeConversationSendBudget(ctx.teamId, conversationId);
      const result = await sendTemplateInternal({
        teamId: ctx.teamId,
        conversationId,
        templateId: config.templateId,
        variables,
        senderUserId: null,
        sentVia: `workflow/${ctx.workflowId}`,
      });
      return advance({
        messageId: result.messageId,
        externalId: result.externalId,
        preview: result.previewBody,
      });
    } catch (err) {
      if (err instanceof ConversationSendRateLimitedError) {
        return advanceWithError(429, "conversation_send_rate_limited", err.message);
      }
      if (err instanceof SendTemplateValidationError) {
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
          body: truncateBody(JSON.stringify({ error: normalized.code, message: normalized.message })),
        };
      }
      throw err;
    }
  },
};
