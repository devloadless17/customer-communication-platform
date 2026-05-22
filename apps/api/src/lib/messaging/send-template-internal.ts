// Note: no `server-only` import — pulled in by the BullMQ worker which boots
// from server.ts, outside the Next bundler context. The handler this serves
// (lib/workflows/steps/send-template.ts) runs inside that worker.

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getProviderBinding, requireProviderMethod } from "@/lib/providers";
import {
  NoChannelDestinationError,
  resolveContactChannel,
} from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import {
  countTemplatePlaceholders,
  renderTemplateBody,
} from "@/lib/providers/meta";
import type { TemplateComponent } from "@ccp/shared/providers/types";
import type { Message } from "@ccp/shared/types";

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
  /**
   * Set on /v1 external-API template sends so the message.sent event +
   * audit timeline attribute the send to the API key instead of a real
   * user. Mutually exclusive with senderUserId in practice.
   */
  senderApiKeyId?: string | null;
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

  let channel;
  try {
    channel = resolveContactChannel(conversation.contact);
  } catch (err) {
    if (err instanceof NoChannelDestinationError) {
      throw new SendTemplateValidationError(
        "contact_has_no_phone",
        "contact_has_no_phone",
        "This contact has no reachable address.",
      );
    }
    throw err;
  }
  // Channel is conversation-owned — bind + stamp from the conversation row;
  // resolveContactChannel above only supplies the destination address.
  const provider = conversation.channel;
  const binding = getProviderBinding(provider);

  let sendConfig;
  try {
    sendConfig = await binding.getSendConfig(args.teamId);
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

  // Templates are a provider capability — channels without a template catalog
  // (SMS, Telegram) raise a typed error here.
  let sendTemplate;
  try {
    sendTemplate = requireProviderMethod(binding.provider, "sendTemplate", provider);
  } catch {
    throw new SendTemplateValidationError(
      "provider_no_template_support",
      "provider does not support templates",
    );
  }

  // Throws on provider error. Caller decides: route maps to 422/502;
  // automation handler turns it into a 422-shaped ActionResult so BullMQ
  // doesn't retry a permanent Meta rejection.
  const send = await sendTemplate(
    {
      to: channel.to,
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

  // Monotonicity guard — same fix as send-text-internal.ts. Meta sends
  // inbound webhook timestamps with second precision, rounded up; an
  // outbound that lands in the same wall-clock second can otherwise
  // appear BEFORE the inbound it replied to in the inbox order.
  const lastTs = conversation.lastMessageAt ?? null;
  const messageTimestamp =
    lastTs && lastTs >= receivedAt
      ? new Date(lastTs.getTime() + 1)
      : receivedAt;

  const created = await createOutboundMessageIdempotent({
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: args.senderUserId,
    body: renderedBody,
    direction: "out",
    channel: provider,
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
    timestamp: messageTimestamp,
  });

  // Read-then-write so a concurrent write that landed during the Meta
  // call doesn't get clobbered backward in time by this bare UPDATE. See
  // send-text-internal.ts for the full rationale.
  const bumped = await db.$transaction(async (tx) => {
    const current = await tx.conversation.findUnique({
      where: { id: args.conversationId },
      select: { lastMessageAt: true, unreadCount: true },
    });
    if (!current) {
      throw new SendTemplateValidationError(
        "conversation_not_found",
        "conversation_disappeared_mid_send",
      );
    }
    const effectiveBump =
      current.lastMessageAt >= messageTimestamp
        ? new Date(current.lastMessageAt.getTime() + 1)
        : messageTimestamp;
    await tx.conversation.update({
      where: { id: args.conversationId },
      data: { lastMessageAt: effectiveBump, lastMessagePreview: previewBody },
    });
    return { lastMessageAt: effectiveBump, unreadCount: current.unreadCount };
  });

  const message: Message = {
    id: created.id,
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: args.senderUserId,
    body: renderedBody,
    direction: "out",
    channel: provider,
    status: "sent",
    rawPayload: {
      sentVia: args.sentVia,
      templateId: template.id,
      templateName: template.name,
    },
    timestamp: messageTimestamp.toISOString(),
  };

  // Publish through the bus so socket-fanout emits `message:new` AND the
  // analytics subscriber bumps counters + firstResponseAt. Template sends
  // ride the same chain as free-form sends.
  await publish({
    type: "message.sent",
    teamId: args.teamId,
    conversationId: args.conversationId,
    contactId: conversation.contactId,
    message,
    preview: previewBody,
    lastMessageAt: bumped.lastMessageAt.toISOString(),
    // Outbound doesn't bump unread; the row's current value is the
    // accurate absolute count.
    unreadCount: bumped.unreadCount,
    senderUserId: args.senderUserId,
    ...(args.senderApiKeyId ? { senderApiKeyId: args.senderApiKeyId } : {}),
  });

  return {
    messageId: created.id,
    externalId: send.externalId,
    previewBody,
  };
}
