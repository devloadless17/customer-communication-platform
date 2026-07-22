// Note: no `server-only` import — pulled in by the BullMQ worker in the NestJS
// api process (@swc-node/register), outside the Next bundler context. The
// handler this serves (lib/workflows/steps/send-template.ts) runs in that
// worker.

import { Prisma } from "@prisma/client";

import { blobStorage } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import { commitOutboundSend } from "@/lib/messaging/commit-outbound-send";
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
import {
  renderTemplateBodyNamed,
  requiredTemplateButtonParams,
  templateNamedPlaceholders,
} from "@ccp/shared/template-render";
import type { TemplateComponent, TemplateVariableSet } from "@ccp/shared/providers/types";
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
  workspaceId: string;
  conversationId: string;
  templateId: string;
  /**
   * The provider's full variable set — `body`, `bodyNamed`, `header`,
   * `headerMedia`, `buttons`. This used to be a narrowed inline shape carrying
   * only body/header/headerMedia, which meant NO caller could ever supply
   * `buttons` or `bodyNamed` even though `metaProvider.sendTemplate` builds both:
   * every template with a dynamic URL button, a coupon copy-code button, or a
   * NAMED body was silently built without those components and hard-rejected by
   * Meta. Widening to the shared type closes that off at the type level.
   */
  variables: TemplateVariableSet;
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
    // Body is NAMED-format (`{{order_id}}`) and the caller supplied no/partial
    // `bodyNamed`. Meta rejects these for missing body parameters.
    | "named_body_vars_required"
    // Template has a dynamic URL button or a copy-code button, which Meta
    // requires a send-time parameter for; the caller supplied none.
    | "button_params_required"
    | "header_var_required"
    | "header_media_required"
    | "header_media_unsupported"
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

  // Single round trip to fetch both rows. workspaceId scoping prevents cross-tenant
  // leakage on either id.
  const [conversation, template] = await Promise.all([
    db.conversation.findFirst({
      where: { id: args.conversationId, workspaceId: args.workspaceId },
      include: { contact: true },
    }),
    db.messageTemplate.findFirst({ where: { id: args.templateId, workspaceId: args.workspaceId } }),
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
  //
  // A body is EITHER positional (`{{1}}`) or NAMED (`{{order_id}}`) — never
  // both — so we pick the matching check. Named bodies previously scored 0
  // positional placeholders, passed validation with zero variables, and were
  // rejected by Meta with nothing the agent could act on.
  const namedBodyVars = templateNamedPlaceholders(template.bodyText);
  if (namedBodyVars.length > 0) {
    const supplied = new Set((args.variables.bodyNamed ?? []).map((v) => v.name));
    const missing = namedBodyVars.filter((n) => !supplied.has(n));
    if (missing.length > 0) {
      throw new SendTemplateValidationError(
        "named_body_vars_required",
        "named body variables required",
        `Template body expects named variable(s): ${missing.join(", ")}.`,
      );
    }
  } else {
    const bodyVarCount = countTemplatePlaceholders(template.bodyText);
    if (args.variables.body.length !== bodyVarCount) {
      throw new SendTemplateValidationError(
        "wrong_body_var_count",
        "wrong variable count",
        `Template body expects ${bodyVarCount} variable(s), got ${args.variables.body.length}.`,
      );
    }
  }

  // Dynamic URL buttons and copy-code buttons carry a send-time parameter. Meta
  // rejects the message without it, so a template like an authentication OTP or
  // a coupon was undeliverable with an opaque provider error. Fail here with the
  // reason instead. (Quick-reply payloads are optional on the wire — not
  // required, so templates that send correctly today keep working.)
  const requiredButtons = requiredTemplateButtonParams(template.components);
  if (requiredButtons.length > 0) {
    const supplied = new Set((args.variables.buttons ?? []).map((b) => `${b.index}:${b.subType}`));
    const missing = requiredButtons.filter((b) => !supplied.has(`${b.index}:${b.subType}`));
    if (missing.length > 0) {
      throw new SendTemplateValidationError(
        "button_params_required",
        "button parameters required",
        `This template's button(s) need a send-time value: ` +
          missing.map((b) => `#${b.index + 1} (${b.subType})`).join(", ") +
          `. Supply them as \`variables.buttons\`.`,
      );
    }
  }

  const components = Array.isArray(template.components)
    ? (template.components as unknown as TemplateComponent[])
    : [];
  const headerComp = components.find((c) => c.type === "HEADER");
  // A TEXT header carries one send-time value in EITHER format: positional
  // `{{1}}` (countTemplatePlaceholders) or NAMED `{{customer_name}}`
  // (templateNamedPlaceholders — WhatsApp allows a single header variable).
  const headerVarCount =
    headerComp?.format === "TEXT" && headerComp.text
      ? countTemplatePlaceholders(headerComp.text)
      : 0;
  const namedHeaderVars =
    headerComp?.format === "TEXT" && headerComp.text
      ? templateNamedPlaceholders(headerComp.text)
      : [];
  // Require the value for BOTH formats. Without the named check a NAMED header
  // slipped past this guard (count sees only `{{n}}`) AND then shipped to Meta
  // with no `parameter_name` → opaque 132000, undeliverable.
  if (
    (headerVarCount > 0 || namedHeaderVars.length > 0) &&
    (!args.variables.header || args.variables.header.length === 0)
  ) {
    throw new SendTemplateValidationError(
      "header_var_required",
      "header variable required",
      "This template's header has a placeholder — fill it in.",
    );
  }
  // NAMED header: pair the value the caller supplied (`header`) with the
  // placeholder name from the template definition so the provider can emit the
  // `parameter_name` Meta demands. The caller never has to know the name.
  const namedHeaderName = namedHeaderVars[0];
  const headerNamed =
    namedHeaderName && args.variables.header
      ? { name: namedHeaderName, text: args.variables.header }
      : undefined;

  // Media-header templates (IMAGE/VIDEO/DOCUMENT) need the actual media for
  // this send, supplied as a public link. Without it Meta rejects the send,
  // so catch it here with an actionable message instead of a cryptic 400.
  const HEADER_MEDIA_FORMATS = { IMAGE: "image", VIDEO: "video", DOCUMENT: "document" } as const;
  const headerMediaKind =
    headerComp && headerComp.format && headerComp.format in HEADER_MEDIA_FORMATS
      ? HEADER_MEDIA_FORMATS[headerComp.format as keyof typeof HEADER_MEDIA_FORMATS]
      : null;
  if (headerComp?.format === "LOCATION") {
    throw new SendTemplateValidationError(
      "header_media_unsupported",
      "location header not supported",
      "Templates with a LOCATION header can't be sent from here yet.",
    );
  }
  if (headerMediaKind) {
    const media = args.variables.headerMedia;
    if (!media || !media.link) {
      throw new SendTemplateValidationError(
        "header_media_required",
        "header media required",
        `This template's header is a ${headerMediaKind} — attach one before sending.`,
      );
    }
    if (media.kind !== headerMediaKind) {
      throw new SendTemplateValidationError(
        "header_media_required",
        "header media kind mismatch",
        `This template's header expects a ${headerMediaKind}, not a ${media.kind}.`,
      );
    }
  }
  // Build the media payload once: only attach when the template header is a
  // media format AND the caller supplied one (validated above). Meta FETCHES
  // this link, and our R2 bucket is private — so if the stored link is one of
  // our own (stable) object URLs, mint a fresh short-lived presigned URL here,
  // at send time. Doing it here (the single choke point for direct + workflow +
  // broadcast + external template sends) means the persisted config keeps the
  // never-expiring stable URL and every send gets a valid signature. A foreign
  // link (not ours) passes through untouched.
  const headerMediaLink =
    headerMediaKind && args.variables.headerMedia
      ? blobStorage.isOwnUrl(args.variables.headerMedia.link)
        ? await blobStorage.presignGetUrl(args.variables.headerMedia.link)
        : args.variables.headerMedia.link
      : undefined;
  const headerMedia =
    headerMediaKind && args.variables.headerMedia && headerMediaLink
      ? {
          kind: headerMediaKind,
          link: headerMediaLink,
          ...(args.variables.headerMedia.filename
            ? { filename: args.variables.headerMedia.filename }
            : {}),
        }
      : undefined;

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
    sendConfig = await binding.getSendConfig(args.workspaceId, conversation.channelConnectionId);
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
        ...(args.variables.bodyNamed ? { bodyNamed: args.variables.bodyNamed } : {}),
        ...(headerNamed
          ? { headerNamed }
          : args.variables.header
            ? { header: args.variables.header }
            : {}),
        ...(headerMedia ? { headerMedia } : {}),
        ...(args.variables.buttons ? { buttons: args.variables.buttons } : {}),
      },
    },
    sendConfig,
  );

  // Store the rendered preview ("Hi John, your order is ready") not the raw
  // template ("Hi {{1}}, your order is {{2}}"), so the inbox shows what the
  // customer actually got. Named bodies render by name, positional by index.
  const renderedBody = args.variables.bodyNamed?.length
    ? renderTemplateBodyNamed(template.bodyText, args.variables.bodyNamed)
    : renderTemplateBody(template.bodyText, args.variables.body);
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
    workspaceId: args.workspaceId,
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
        ...(args.variables.bodyNamed ? { bodyNamed: args.variables.bodyNamed } : {}),
        ...(headerNamed
          ? { headerNamed }
          : args.variables.header
            ? { header: args.variables.header }
            : {}),
        ...(headerMedia ? { headerMedia } : {}),
        ...(args.variables.buttons ? { buttons: args.variables.buttons } : {}),
      },
    } as unknown as Prisma.InputJsonValue,
    timestamp: messageTimestamp,
  });

  const message: Message = {
    id: created.id,
    workspaceId: args.workspaceId,
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

  // Strict-monotonic bump + atomic message.sent publish, unified in
  // commitOutboundSend (see that file for the full rationale).
  await commitOutboundSend({
    conversationId: args.conversationId,
    bumpTimestamp: messageTimestamp,
    preview: previewBody,
    event: {
      type: "message.sent",
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      message,
      preview: previewBody,
      senderUserId: args.senderUserId,
      ...(args.senderApiKeyId ? { senderApiKeyId: args.senderApiKeyId } : {}),
    },
    onMissing: () => {
      throw new SendTemplateValidationError(
        "conversation_not_found",
        "conversation_disappeared_mid_send",
      );
    },
  });

  return {
    messageId: created.id,
    externalId: send.externalId,
    previewBody,
  };
}
