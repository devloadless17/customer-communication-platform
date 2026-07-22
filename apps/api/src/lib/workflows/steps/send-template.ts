import {
  SendTemplateValidationError,
  sendTemplateInternal,
} from "@/lib/messaging/send-template-internal";
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
import { buildTokenContext } from "./token-context";
import {
  type StepTarget,
  parseStepTarget,
  resolveStepTarget,
} from "./target";

export interface SendTemplateStepConfig {
  templateId: string;
  variables: {
    body: string[];
    header?: string;
    /** Static media for an IMAGE/VIDEO/DOCUMENT template header — a public link
     *  the workflow author sets once (same media for every triggered send). */
    headerMedia?: { kind: "image" | "video" | "document"; link: string; filename?: string };
  };
  /** Who to send to. Default = the trigger conversation's contact. A `phone`
   *  target reaches ANY number (auto-creates the contact + conversation) —
   *  templates are the cold-reachout path, so out-of-24h-window is fine. */
  target?: StepTarget;
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
    let headerMedia: SendTemplateStepConfig["variables"]["headerMedia"];
    const hm = v.headerMedia as
      | { kind?: unknown; link?: unknown; filename?: unknown }
      | undefined;
    if (hm && typeof hm === "object") {
      if (
        (hm.kind === "image" || hm.kind === "video" || hm.kind === "document") &&
        typeof hm.link === "string" &&
        hm.link.length > 0
      ) {
        headerMedia = {
          kind: hm.kind,
          link: hm.link,
          ...(typeof hm.filename === "string" ? { filename: hm.filename } : {}),
        };
      } else {
        throw new StepConfigError(
          "send_template.variables.headerMedia must be { kind: image|video|document, link }",
        );
      }
    }
    const target = parseStepTarget(r.target);
    return {
      templateId: r.templateId,
      variables: {
        body,
        ...(header ? { header } : {}),
        ...(headerMedia ? { headerMedia } : {}),
      },
      ...(target ? { target } : {}),
    };
  },
  describeConfig(config) {
    const head = `Send template ${config.templateId}`;
    return config.target?.kind === "phone"
      ? `${head} → ${config.target.phoneNumber}`
      : head;
  },
  async run(envelope, config, ctx): Promise<StepResult> {
    let resolved;
    try {
      resolved = await resolveStepTarget(config.target, envelope, ctx.workspaceId, {
        createConversation: true,
      });
    } catch (err) {
      if (err instanceof StepConfigError) return advanceWithError(400, err.message);
      throw err;
    }
    if (!resolved.conversationId) {
      return advanceWithError(400, "could not resolve a conversation for the target");
    }
    const conversationId = resolved.conversationId;
    // Full contact (target) + trigger sender so every $var.contact.* /
    // $var.sender.* token resolves (incl. stage_name / tag_names / …).
    const { contact, extras } = await buildTokenContext(
      envelope,
      ctx,
      ctx.workspaceId,
      resolved.contactId,
    );
    const variables = {
      body: config.variables.body.map((v) => resolveFieldTokens(v, contact, extras)),
      ...(config.variables.header
        ? { header: resolveFieldTokens(config.variables.header, contact, extras) }
        : {}),
      // headerMedia is a static public link — no token resolution.
      ...(config.variables.headerMedia
        ? { headerMedia: config.variables.headerMedia }
        : {}),
    };

    try {
      // Per-conversation send ceiling — same loop backstop as send_message.
      // Templates are billed cold-outbound, so a runaway template loop is the
      // most expensive variant; cap it per thread before reaching Meta.
      consumeConversationSendBudget(ctx.workspaceId, conversationId);
      const result = await sendTemplateInternal({
        workspaceId: ctx.workspaceId,
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
