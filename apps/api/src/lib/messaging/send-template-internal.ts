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
  LIMITED_TIME_OFFER_LIMITS,
  TEMPLATE_AUTO_ARCHIVE_MONTHS,
  TEMPLATE_LIMITS,
  encodeUrlButtonValue,
  renderTemplateBodyNamed,
  requiredCarouselCards,
  requiredTemplateButtonParams,
  templateNeedsOfferExpiry,
  templateDeletionDaysLeft,
  templateNamedPlaceholders,
  unsupportedTemplateFeature,
  validateTemplateParamValues,
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
    // A Template Library template declares a value TYPE per body parameter
    // (EMAIL, NUMBER, AMOUNT…) which Meta enforces at send time.
    | "param_type_mismatch"
    // Commerce template (catalog/MPM/SPM/order-details) — needs product
    // parameters the platform can't supply, so every send would fail at Meta.
    | "template_feature_unsupported"
    | "header_var_required"
    | "header_media_required"
    | "header_media_unsupported"
    // Template header is a LOCATION map and the caller supplied no (or a
    // partial) pin. Meta rejects the send without all four fields.
    | "header_location_required"
    // Template carries a LIMITED_TIME_OFFER component but no (or a past) expiry
    // instant, so the countdown has nothing to count to.
    | "limited_time_offer_expiry_required"
    // Template carries a CAROUSEL and the per-card values don't match what it
    // was approved with (count, media kind, body values, or a button value).
    | "carousel_cards_required"
    // The template belongs to a different WhatsApp Business Account than the
    // number this thread replies from. Meta rejects it with an opaque error.
    | "template_wrong_account"
    // The sending number has no WABA linked, so it has no template catalog at all.
    | "waba_unknown"
    | "contact_has_no_phone"
    // The workspace blocked this contact (Block Users API) — the provider
    // rejects every send to them, so refuse up front with the reason.
    | "contact_blocked"
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
  if (conversation.contact.blockedAt) {
    throw new SendTemplateValidationError(
      "contact_blocked",
      "contact_blocked",
      "This contact is blocked. Unblock them to send messages.",
    );
  }
  if (!template) {
    throw new SendTemplateValidationError("template_not_found", "template not found");
  }
  if (template.status !== "approved") {
    // An archived template is the one non-sendable state with a way back AND a
    // deadline, so it gets its own message: "disabled" would be true and useless.
    const daysLeft =
      template.status === "archived"
        ? templateDeletionDaysLeft(template.archivedAt)
        : null;
    throw new SendTemplateValidationError(
      "template_not_approved",
      "template not approved",
      template.status === "archived"
        ? `Template was archived after ${TEMPLATE_AUTO_ARCHIVE_MONTHS} months without use. ` +
          `Unarchive it in WhatsApp Manager to restore it` +
          (daysLeft !== null
            ? ` — Meta deletes it permanently in about ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`
            : `.`)
        : `Template is ${template.status}. Only approved templates can be sent.`,
    );
  }

  // Validate var shape matches the template's placeholders. Caller is
  // expected to fill these out at config time; surfacing the mismatch here
  // catches drift between a config and a template that was later edited.
  //
  // A body is EITHER positional (`{{1}}`) or NAMED (`{{order_id}}`) — never both
  // — and WHICH one is decided by the stored `parameterFormat`, i.e. Meta's own
  // `parameter_format`, NOT by a regex over the body. That distinction is the
  // whole reason the column exists: a positional template whose body contains
  // the literal copy `{{order_id}}` reads as named to a regex, and we would then
  // build the named wire shape and fail every recipient with error 132000.
  const isNamed = template.parameterFormat === "named";
  const namedBodyVars = isNamed ? templateNamedPlaceholders(template.bodyText) : [];
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

  // Commerce templates (catalog / MPM / SPM / order-details / product cards)
  // need send-time product parameters nothing here collects — every send
  // would fail at Meta with an unlabelled error, so refuse with the reason.
  {
    const unsupported = unsupportedTemplateFeature(template.components);
    if (unsupported) {
      throw new SendTemplateValidationError(
        "template_feature_unsupported",
        "template feature unsupported",
        `This template uses ${unsupported}, which this platform can't send yet.`,
      );
    }
  }

  // Authentication templates cap every parameter at 15 characters (Meta's
  // template-categorization rules, alongside the no-URL/media/emoji content
  // restrictions). A longer value fails the send with an error that names
  // neither the parameter nor the limit.
  if (template.category === "authentication") {
    const max = TEMPLATE_LIMITS.authCodeMaxLength;
    const tooLong = args.variables.body.findIndex((v) => v.length > max);
    if (tooLong >= 0) {
      throw new SendTemplateValidationError(
        "param_type_mismatch",
        "authentication parameter too long",
        `Authentication template values are limited to ${max} characters — value ` +
          `${tooLong + 1} is ${args.variables.body[tooLong]!.length}.`,
      );
    }
  }

  // Library templates carry a declared TYPE per body parameter, and Meta checks
  // those types at send time — a bad value fails the individual message with an
  // error naming neither the parameter nor the reason. Checking first turns that
  // into "value 2 (email) must be a valid email address".
  if (template.bodyParamTypes.length > 0) {
    const typeIssues = validateTemplateParamValues(
      template.bodyParamTypes,
      args.variables.body,
    );
    if (typeIssues.length > 0) {
      throw new SendTemplateValidationError(
        "param_type_mismatch",
        "template parameter type mismatch",
        typeIssues.map((i) => i.message).join(" "),
      );
    }
  }

  // Dynamic URL buttons and copy-code buttons carry a send-time parameter. Meta
  // rejects the message without it, so a template like an authentication OTP or
  // a coupon was undeliverable with an opaque provider error. Fail here with the
  // reason instead. (Quick-reply payloads are optional on the wire — not
  // required, so templates that send correctly today keep working.)
  // Category is load-bearing: an authentication template's OTP button is
  // rewritten by Meta to type `url` on creation, so it can only be recognized
  // from the template's category, not from the button itself.
  const requiredButtons = requiredTemplateButtonParams(
    template.components,
    template.category,
  );

  // An authentication template's OTP button carries the SAME verification code
  // as the body, so fill it from `body[0]` instead of demanding it twice. Meta's
  // own examples put one code in both places, and asking an agent to retype it
  // invites a message whose button copies a different code than the text shows.
  const autofilledButtons = requiredButtons
    .filter((b) => b.autofillFromBody)
    .filter(
      (b) =>
        !(args.variables.buttons ?? []).some(
          (supplied) => supplied.index === b.index && supplied.subType === b.subType,
        ),
    )
    .map((b) => ({ index: b.index, subType: b.subType, text: args.variables.body[0] ?? "" }))
    .filter((b) => b.text.length > 0);
  const effectiveButtonsRaw = [...(args.variables.buttons ?? []), ...autofilledButtons];

  // NAMED-format templates: Meta requires `parameter_name` on a URL button's
  // parameter. The name lives only in the template's stored URL, so it is
  // resolved HERE from `requiredButtons` (server truth) rather than trusted
  // from the client's button payload.
  const paramNameByKey = new Map<string, string>(
    requiredButtons
      .filter((b) => b.paramName)
      .map((b) => [`${b.index}:${b.subType}`, b.paramName!]),
  );
  // Which url-subType buttons carry an OTP CODE rather than a URL suffix.
  // Both share sub_type "url" on the wire, but only the suffix gets
  // percent-encoded below — Meta's own authentication example sends the code
  // verbatim, and encoding `J$FpnYnP` to `J%24FpnYnP` breaks autofill.
  const otpKeys = new Set(
    requiredButtons
      .filter((b) => b.autofillFromBody)
      .map((b) => `${b.index}:${b.subType}`),
  );
  const effectiveButtons = effectiveButtonsRaw.map((b) => {
    const key = `${b.index}:${b.subType}`;
    const paramName = paramNameByKey.get(key);
    // Percent-encode a dynamic URL suffix. Meta's components doc is explicit:
    // unencoded special characters (spaces, `:`, `|`, `ç`, `ñ`, …) in a URL
    // parameter make the generated URL fail validation and the send error.
    // Already-encoded input passes through untouched (double-encoding turns
    // %20 into %2520): a value that decodes cleanly AND re-encodes to itself
    // is already in wire form.
    const text =
      b.subType === "url" && !otpKeys.has(key)
        ? encodeUrlButtonValue(b.text)
        : b.text;
    return { ...b, text, ...(paramName ? { paramName } : {}) };
  });

  if (requiredButtons.length > 0) {
    const supplied = new Set(effectiveButtons.map((b) => `${b.index}:${b.subType}`));
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

  // A MARKETING coupon's send-time code shares the create-example's cap —
  // 20 characters for a plain coupon button, but only 15 when the template is
  // a limited-time offer (its reference caps the offer code tighter). A longer
  // one fails at Meta without naming the field. Auth copy-code buttons never
  // reach this: their sub_type is `url` (otpKeys) and the 15-char
  // authentication guard above covers them.
  {
    const hasLto =
      Array.isArray(template.components) &&
      (template.components as Array<{ type?: unknown }>).some(
        (c) => typeof c?.type === "string" && c.type.toUpperCase() === "LIMITED_TIME_OFFER",
      );
    const codeMax = hasLto
      ? LIMITED_TIME_OFFER_LIMITS.offerCodeMaxLength
      : TEMPLATE_LIMITS.copyCodeExampleMaxLength;
    for (const b of effectiveButtons) {
      if (b.subType === "copy_code" && b.text.length > codeMax) {
        throw new SendTemplateValidationError(
          "param_type_mismatch",
          "coupon code too long",
          `${hasLto ? "A limited-time offer code" : "Coupon codes"} ` +
            `${hasLto ? "is" : "are"} limited to ${codeMax} characters — ` +
            `button #${b.index + 1}'s is ${b.text.length}.`,
        );
      }
    }
  }

  const components = Array.isArray(template.components)
    ? (template.components as unknown as TemplateComponent[])
    : [];
  // Carousel cards. The count is FIXED at approval, so a mismatch fails the
  // send outright at Meta — catch it here where the message names the number.
  const requiredCards = requiredCarouselCards(components);
  if (requiredCards.length > 0) {
    const supplied = args.variables.cards ?? [];
    if (supplied.length !== requiredCards.length) {
      throw new SendTemplateValidationError(
        "carousel_cards_required",
        `carousel expects ${requiredCards.length} cards, got ${supplied.length}`,
        `This template was approved with ${requiredCards.length} cards — send exactly that many.`,
      );
    }
    for (const [i, need] of requiredCards.entries()) {
      const card = supplied[i]!;
      if (card.headerMedia.kind !== need.headerKind) {
        throw new SendTemplateValidationError(
          "carousel_cards_required",
          `card ${i + 1} expects a ${need.headerKind}`,
          `Card ${i + 1} of this template is a ${need.headerKind} — attach one.`,
        );
      }
      if ((card.body?.length ?? 0) !== need.bodyVarCount) {
        throw new SendTemplateValidationError(
          "carousel_cards_required",
          `card ${i + 1} expects ${need.bodyVarCount} body value(s)`,
          `Card ${i + 1} needs ${need.bodyVarCount} value(s) filled in.`,
        );
      }
      for (const b of need.buttons) {
        const value = (card.buttons ?? []).find(
          (x) => x.index === b.index && x.subType === b.subType,
        );
        if (!value || value.text.trim() === "") {
          throw new SendTemplateValidationError(
            "carousel_cards_required",
            `card ${i + 1} button ${b.index + 1} needs a value`,
            `Card ${i + 1}'s button needs a value before this can send.`,
          );
        }
      }
    }
  }

  // A limited-time offer's countdown has nothing to count to without an expiry
  // instant, and Meta rejects the send. Catch it here with the reason.
  if (templateNeedsOfferExpiry(components)) {
    const expiresAt = args.variables.limitedTimeOfferExpiresAtMs;
    if (expiresAt === undefined) {
      throw new SendTemplateValidationError(
        "limited_time_offer_expiry_required",
        "offer expiry required",
        "This template shows a countdown — set when the offer expires before sending.",
      );
    }
    // An expiry already in the past renders an offer that is over on arrival.
    // Meta accepts it; the customer just gets something useless.
    if (expiresAt <= Date.now()) {
      throw new SendTemplateValidationError(
        "limited_time_offer_expiry_required",
        "offer already expired",
        "That offer expiry is in the past — the countdown would be over before the message arrives.",
      );
    }
  }

  const headerComp = components.find((c) => c.type === "HEADER");
  // A TEXT header carries one send-time value in EITHER format: positional
  // `{{1}}` (countTemplatePlaceholders) or NAMED `{{customer_name}}`
  // (templateNamedPlaceholders — WhatsApp allows a single header variable).
  const headerVarCount =
    headerComp?.format === "TEXT" && headerComp.text
      ? countTemplatePlaceholders(headerComp.text)
      : 0;
  const namedHeaderVars =
    isNamed && headerComp?.format === "TEXT" && headerComp.text
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
  // LOCATION headers carry the whole pin at SEND time (the component is
  // declared with no parameters at create time). Only the coordinates are
  // required — see the guard below.
  const headerLocation =
    headerComp?.format === "LOCATION" ? args.variables.headerLocation : undefined;
  if (headerComp?.format === "LOCATION") {
    // ONLY latitude and longitude are required. `name` and `address` are
    // optional per Meta's location-template reference — demanding them refuses a
    // send Meta would accept, which is the same failure mode as a too-tight
    // length limit and just as invisible.
    const missing = (["latitude", "longitude"] as const).filter(
      (k) => !headerLocation?.[k]?.trim(),
    );
    if (missing.length > 0) {
      throw new SendTemplateValidationError(
        "header_location_required",
        "header location required",
        `This template's header is a map — supply ${missing.join(" and ")}.`,
      );
    }
  }
  if (headerMediaKind) {
    const media = args.variables.headerMedia;
    // Either form satisfies the requirement — an id means Meta already has it.
    if (!media || !(media.link || media.id)) {
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
  // media format AND the caller supplied one (validated above).
  //
  // A caller-supplied media `id` is used as-is — Meta already holds the bytes,
  // nothing is fetched from us, and there is no link to presign. Otherwise Meta
  // FETCHES the link, and our R2 bucket is private, so one of our own (stable)
  // object URLs is presigned fresh HERE, at send time. Doing it at this single
  // choke point (direct + workflow + broadcast + external template sends) means
  // the persisted config keeps the never-expiring stable URL and every send gets
  // a valid signature. A foreign link (not ours) passes through untouched.
  const suppliedMedia =
    headerMediaKind && args.variables.headerMedia ? args.variables.headerMedia : null;
  const headerMediaLink =
    suppliedMedia && !suppliedMedia.id && suppliedMedia.link
      ? blobStorage.isOwnUrl(suppliedMedia.link)
        ? await blobStorage.presignGetUrl(suppliedMedia.link)
        : suppliedMedia.link
      : undefined;
  const headerMedia =
    suppliedMedia && headerMediaKind && (suppliedMedia.id || headerMediaLink)
      ? {
          kind: headerMediaKind,
          ...(suppliedMedia.id ? { id: suppliedMedia.id } : { link: headerMediaLink! }),
          ...(suppliedMedia.filename ? { filename: suppliedMedia.filename } : {}),
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

  // A template belongs to a WhatsApp Business Account, and a number can only
  // send templates from its OWN WABA. Sending one from the wrong account is
  // rejected by Meta per-recipient with an opaque error, so catch it here.
  //
  // The broadcast path guards this at campaign creation
  // (broadcasts.service.ts, `template_wrong_account`); this is the same rule
  // for every 1:1 send — the inbox composer, `/v1`, and the workflow
  // `send_template` step. Free: `wabaId` is already on the send config, so
  // there is no extra query.
  //
  // A NULL account WABA is a REFUSAL, not "no opinion". This guard used to read
  // `accountWaba && templateWaba && accountWaba !== templateWaba`, where both
  // sides defaulted to the `""` sentinel — so it silently passed whenever either
  // side was unknown. Two real holes followed from that: a legacy template was
  // sendable from ANY account, and a connection whose WABA was never pasted could
  // send ANY of the workspace's templates. The template side is now a NOT NULL FK,
  // so only the account side can be absent, and that is refused explicitly.
  const accountWabaAccountId = (sendConfig as { wabaAccountId?: string }).wabaAccountId;
  if (!accountWabaAccountId) {
    throw new SendTemplateValidationError(
      "waba_unknown",
      "sending number has no WhatsApp Business Account linked",
      "The number this conversation replies from has no WhatsApp Business Account " +
        "linked, so it has no template catalog. Add its WABA ID in WhatsApp settings.",
    );
  }
  if (accountWabaAccountId !== template.wabaAccountId) {
    throw new SendTemplateValidationError(
      "template_wrong_account",
      "template belongs to a different WhatsApp Business Account",
      "That template belongs to a different WhatsApp Business Account than the number " +
        "this conversation replies from. Pick a template from this account.",
    );
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
        ...(headerLocation ? { headerLocation } : {}),
        ...(effectiveButtons.length > 0 ? { buttons: effectiveButtons } : {}),
        ...(args.variables.tapTarget ? { tapTarget: args.variables.tapTarget } : {}),
        ...(args.variables.limitedTimeOfferExpiresAtMs !== undefined
          ? { limitedTimeOfferExpiresAtMs: args.variables.limitedTimeOfferExpiresAtMs }
          : {}),
        ...(args.variables.cards ? { cards: args.variables.cards } : {}),
      },
    },
    sendConfig,
  );

  if (send.heldForQualityAssessment) {
    console.warn(
      `[send-template] Meta HELD message ${send.externalId} for a pacing quality ` +
        `assessment (workspace ${args.workspaceId}, template "${template.name}") — ` +
        `it will be released in a later batch or dropped with code 132015/135000.`,
    );
  }

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
    // Durable template marker. `rawPayload.templateName` below is kept for
    // back-compat, but the rawPayload-retention sweeper COLLAPSES that blob — the
    // same reason `broadcastId` became a real column. This one makes the portfolio
    // 24h messaging budget honest: a template sent from the composer, a workflow or
    // `/v1` spends Meta's real budget, and before this column the gate counted only
    // broadcast recipients and so under-reported.
    templateName: template.name,
    rawPayload: {
      sentVia: args.sentVia,
      // Portfolio/template pacing: Meta accepted this send but is HOLDING it
      // for a quality assessment — it releases in a later batch (normal sent/
      // delivered webhooks follow) or is dropped (failed webhook, 132015/
      // 135000), so `status` self-corrects either way. Recorded here so a
      // "sent an hour ago, still no receipt" investigation has its answer.
      ...(send.heldForQualityAssessment ? { heldForQualityAssessment: true } : {}),
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
        ...(headerLocation ? { headerLocation } : {}),
        ...(effectiveButtons.length > 0 ? { buttons: effectiveButtons } : {}),
        ...(args.variables.tapTarget ? { tapTarget: args.variables.tapTarget } : {}),
        ...(args.variables.limitedTimeOfferExpiresAtMs !== undefined
          ? { limitedTimeOfferExpiresAtMs: args.variables.limitedTimeOfferExpiresAtMs }
          : {}),
        ...(args.variables.cards ? { cards: args.variables.cards } : {}),
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

  // Sending is one of the activities that resets Meta's 12-month auto-archival
  // clock, so record it — that is what lets the app warn BEFORE a template is
  // archived instead of only reporting it afterwards.
  //
  // Fire-and-forget: a failure here costs a warning, never a delivered message.
  void db.messageTemplate
    .updateMany({
      where: { id: template.id, workspaceId: args.workspaceId },
      data: { lastUsedAt: messageTimestamp },
    })
    .catch(() => undefined);

  return {
    messageId: created.id,
    externalId: send.externalId,
    previewBody,
  };
}
