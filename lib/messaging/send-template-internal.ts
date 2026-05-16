// Note: no `server-only` import — pulled in by the BullMQ worker which boots
// from server.ts, outside the Next bundler context. The handler this serves
// (lib/workflows/steps/send-template.ts) runs inside that worker.

import { Prisma } from "@prisma/client";

import { trackOnOutboundMessage } from "@/lib/conversations/analytics";
import { db } from "@/lib/db";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import {
  countTemplatePlaceholders,
  renderTemplateBody,
} from "@/lib/providers/meta";
import type { TemplateComponent } from "@/lib/providers/types";
import { emitToTeam } from "@/lib/socket/server";
import type { Message } from "@/lib/types";

/**
 * Template-send core, lifted from app/api/messages/template/route.ts so the
 * automations action handler can reuse it. The route still owns auth,
 * request parsing, and HTTP error mapping; this function owns the four
 * things both callers need to do identically:
 *
 *   1. Validate the template (belongs to team, approved, var counts match)
 *   2. Resolve provider send config (per-team or env fallback)
 *   3. Call provider.sendTemplate
 *   4. Persist + emit socket + bump conversation summary
 *
 * Errors are typed so callers can map them to HTTP responses or to an
 * AutomationRun row without re-parsing message strings.
 */

export interface SendTemplateInternalArgs {
  teamId: string;
  conversationId: string;
  templateId: string;
  variables: {
    body: string[];
    header?: string;
  };
  /** Null for system / automation sends. */
  senderUserId: string | null;
  /** Provenance label for raw_payload.sentVia. e.g. "automation/<automationId>". */
  sentVia: string;
}

export interface SendTemplateInternalResult {
  messageId: string;
  externalId: string;
  previewBody: string;
}

/** Validation-time problem. Caller should NOT retry. */
export class SendTemplateValidationError extends Error {
  code:
    | "conversation_not_found"
    | "template_not_found"
    | "template_not_approved"
    | "wrong_body_var_count"
    | "header_var_required"
    | "contact_has_no_phone"
    | "provider_not_configured"
    | "provider_no_template_support";
  detail?: string;

  constructor(
    code: SendTemplateValidationError["code"],
    message: string,
    detail?: string,
  ) {
    super(message);
    this.name = "SendTemplateValidationError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export async function sendTemplateInternal(
  args: SendTemplateInternalArgs,
): Promise<SendTemplateInternalResult> {
  const receivedAt = new Date();

  // Single round trip to fetch both rows. teamId scoping prevents cross-tenant
  // leakage on either id.
  const [conversation, template] = await Promise.all([
    db.conversation.findFirst({
      where: { id: args.conversationId, teamId: args.teamId },
      include: { contact: true },
    }),
    db.messageTemplate.findFirst({ where: { id: args.templateId, teamId: args.teamId } }),
  ]);

  if (!conversation) {
    throw new SendTemplateValidationError(
      "conversation_not_found",
      "conversation not found",
    );
  }
  if (!template) {
    throw new SendTemplateValidationError("template_not_found", "template not found");
  }
  if (template.status !== "approved") {
    throw new SendTemplateValidationError(
      "template_not_approved",
      "template not approved",
      `Template is ${template.status}. Only approved templates can be sent.`,
    );
  }

  // Validate var shape matches the template's placeholders. Caller is
  // expected to fill these out at config time; surfacing the mismatch here
  // catches drift between a config and a template that was later edited.
  const bodyVarCount = countTemplatePlaceholders(template.bodyText);
  if (args.variables.body.length !== bodyVarCount) {
    throw new SendTemplateValidationError(
      "wrong_body_var_count",
      "wrong variable count",
      `Template body expects ${bodyVarCount} variable(s), got ${args.variables.body.length}.`,
    );
  }

  const components = Array.isArray(template.components)
    ? (template.components as unknown as TemplateComponent[])
    : [];
  const headerComp = components.find((c) => c.type === "HEADER");
  const headerVarCount =
    headerComp?.format === "TEXT" && headerComp.text
      ? countTemplatePlaceholders(headerComp.text)
      : 0;
  if (headerVarCount > 0 && (!args.variables.header || args.variables.header.length === 0)) {
    throw new SendTemplateValidationError(
      "header_var_required",
      "header variable required",
      "This template's header has a placeholder — fill it in.",
    );
  }

  if (!conversation.contact.phoneNumber) {
    throw new SendTemplateValidationError(
      "contact_has_no_phone",
      "contact_has_no_phone",
      "This contact has no WhatsApp number.",
    );
  }

  let sendConfig;
  try {
    sendConfig = await getMetaSendConfig(args.teamId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      throw new SendTemplateValidationError(
        "provider_not_configured",
        "whatsapp not connected",
        err.message,
      );
    }
    throw err;
  }

  const provider = getMetaProvider();
  if (!provider.sendTemplate) {
    throw new SendTemplateValidationError(
      "provider_no_template_support",
      "provider does not support templates",
    );
  }

  // Throws on provider error. Caller decides: route maps to 422/502;
  // automation handler turns it into a 422-shaped ActionResult so BullMQ
  // doesn't retry a permanent Meta rejection.
  const send = await provider.sendTemplate(
    {
      to: conversation.contact.phoneNumber,
      name: template.name,
      language: template.language,
      variables: {
        body: args.variables.body,
        ...(args.variables.header ? { header: args.variables.header } : {}),
      },
    },
    sendConfig,
  );

  // Store the rendered preview ("Hi John, your order is ready") not the raw
  // template ("Hi {{1}}, your order is {{2}}"), so the inbox shows what the
  // customer actually got.
  const renderedBody = renderTemplateBody(template.bodyText, args.variables.body);
  const previewBody = renderedBody.slice(0, 200);

  const created = await createOutboundMessageIdempotent({
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: args.senderUserId,
    body: renderedBody,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: {
      sentVia: args.sentVia,
      templateId: template.id,
      templateName: template.name,
      templateLanguage: template.language,
      variables: {
        body: args.variables.body,
        ...(args.variables.header ? { header: args.variables.header } : {}),
      },
    } as Prisma.InputJsonValue,
    timestamp: receivedAt,
  });

  await db.conversation.update({
    where: { id: args.conversationId },
    data: {
      lastMessageAt: send.timestamp,
      lastMessagePreview: previewBody,
    },
  });

  const message: Message = {
    id: created.id,
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: args.senderUserId,
    body: renderedBody,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: {
      sentVia: args.sentVia,
      templateId: template.id,
      templateName: template.name,
    },
    timestamp: receivedAt.toISOString(),
  };

  emitToTeam(args.teamId, "message:new", {
    teamId: args.teamId,
    conversationId: args.conversationId,
    message,
    preview: previewBody,
    lastMessageAt: send.timestamp.toISOString(),
    unreadDelta: 0,
  });

  void trackOnOutboundMessage({
    conversationId: args.conversationId,
    teamId: args.teamId,
    senderUserId: args.senderUserId,
  });

  return {
    messageId: created.id,
    externalId: send.externalId,
    previewBody,
  };
}
