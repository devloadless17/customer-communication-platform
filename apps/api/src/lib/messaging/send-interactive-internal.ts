// Note: no `server-only` import — pulled in by the BullMQ workflow worker
// which boots from server.ts, outside the Next bundler context.

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import type { Message } from "@ccp/shared/types";
import type { InteractiveOption } from "@ccp/shared/providers/types";
import { computeWindowStatus } from "@ccp/shared/utils/window";

import { SendTextValidationError } from "./send-text-internal";

/**
 * Sibling of `sendTextInternal` for outbound interactive messages (buttons /
 * list). Same 24h-window + provider-config + idempotent-create flow as the
 * text path; the only differences are the payload shape and the
 * `provider.sendInteractive?` optional-method check (providers that don't
 * support interactive return a typed error so the caller can fall back).
 *
 * Used by the `ask_question` workflow step. Direct callers — there's no
 * inbox-side composer for interactive messages today; agents send text only.
 */

export interface SendInteractiveInternalArgs {
  teamId: string;
  conversationId: string;
  bodyText: string;
  kind: "buttons" | "list";
  options: InteractiveOption[];
  listCtaLabel?: string;
  listSectionTitle?: string;
  /** Provenance label for raw_payload.sentVia. e.g. "workflow/<id>". */
  sentVia: string;
}

export interface SendInteractiveInternalResult {
  messageId: string;
  externalId: string;
}

export async function sendInteractiveInternal(
  args: SendInteractiveInternalArgs,
): Promise<SendInteractiveInternalResult> {
  const receivedAt = new Date();
  const bodyText = args.bodyText.trim();
  if (!bodyText) {
    throw new SendTextValidationError("empty_body", "body is required");
  }

  const conversation = await db.conversation.findFirst({
    where: { id: args.conversationId, teamId: args.teamId },
    select: {
      id: true,
      contactId: true,
      lastMessageAt: true,
      contact: { select: { phoneNumber: true, lastInboundAt: true } },
    },
  });
  if (!conversation) {
    throw new SendTextValidationError("conversation_not_found", "conversation not found");
  }
  if (!conversation.contact.phoneNumber) {
    throw new SendTextValidationError("contact_has_no_phone", "contact has no WhatsApp number");
  }

  // 24h window — same gate as plain text. Outside the window, free-form
  // interactive is also rejected by Meta.
  const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;
  const win = computeWindowStatus(lastInboundAt);
  if (win.state === "closed" || win.state === "never") {
    throw new SendTextValidationError(
      "outside_24h_window",
      "outside_24h_window",
      "24h customer-service window closed — use a template step instead.",
    );
  }

  let sendConfig;
  try {
    sendConfig = await getMetaSendConfig(args.teamId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      throw new SendTextValidationError(
        "provider_not_configured",
        "whatsapp_not_connected",
        err.message,
      );
    }
    throw err;
  }

  const provider = getMetaProvider();
  if (!provider.sendInteractive) {
    // Defensive — Meta does implement sendInteractive in this codebase, but
    // if the provider abstraction is ever swapped (e.g. an SMS provider)
    // surface a typed error rather than crashing on undefined.
    throw new SendTextValidationError(
      "provider_not_configured",
      "interactive_not_supported",
      "the active provider doesn't support interactive messages",
    );
  }

  const send = await provider.sendInteractive(
    {
      to: conversation.contact.phoneNumber,
      bodyText,
      kind: args.kind,
      options: args.options,
      ...(args.listCtaLabel ? { listCtaLabel: args.listCtaLabel } : {}),
      ...(args.listSectionTitle ? { listSectionTitle: args.listSectionTitle } : {}),
    },
    sendConfig,
  );

  // Strict timestamp ordering, same idiom as sendTextInternal.
  const lastTs = conversation.lastMessageAt ?? null;
  const messageTimestamp =
    lastTs && lastTs >= receivedAt
      ? new Date(lastTs.getTime() + 1)
      : receivedAt;

  // Persist as a regular outbound message — body is the question text the
  // contact saw; the structured options live in rawPayload so they survive
  // for debugging without bloating the searchable body column.
  const created = await createOutboundMessageIdempotent({
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: null,
    body: bodyText,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: {
      sentVia: args.sentVia,
      interactive: {
        kind: args.kind,
        options: args.options.map((o) => ({ id: o.id, title: o.title })),
      },
    } as Prisma.InputJsonValue,
    timestamp: messageTimestamp,
  });

  // Bump conversation.lastMessageAt + preview inside a tx using FRESH
  // values so a racing inbound webhook can't regress the clock. Same
  // pattern as sendTextInternal.
  const previewBody = bodyText.slice(0, 200);
  const bumped = await db.$transaction(async (tx) => {
    const current = await tx.conversation.findUnique({
      where: { id: args.conversationId },
      select: { lastMessageAt: true, unreadCount: true },
    });
    if (!current) {
      throw new SendTextValidationError(
        "conversation_not_found",
        "conversation_disappeared_mid_send",
      );
    }
    const effectiveBump =
      current.lastMessageAt && current.lastMessageAt >= messageTimestamp
        ? new Date(current.lastMessageAt.getTime() + 1)
        : messageTimestamp;
    await tx.conversation.update({
      where: { id: args.conversationId },
      data: { lastMessageAt: effectiveBump, lastMessagePreview: previewBody },
    });
    return { lastMessageAt: effectiveBump, unreadCount: current.unreadCount };
  });

  // Publish on the bus so the realtime socket sees the new message and
  // analytics counters tick the same way they do for plain text sends.
  const message: Message = {
    id: created.id,
    teamId: args.teamId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: null,
    body: bodyText,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: {
      sentVia: args.sentVia,
      interactive: {
        kind: args.kind,
        options: args.options.map((o) => ({ id: o.id, title: o.title })),
      },
    },
    timestamp: messageTimestamp.toISOString(),
  };
  await publish({
    type: "message.sent",
    teamId: args.teamId,
    conversationId: args.conversationId,
    contactId: conversation.contactId,
    message,
    preview: previewBody,
    lastMessageAt: bumped.lastMessageAt.toISOString(),
    unreadCount: bumped.unreadCount,
    senderUserId: null,
  });

  return { messageId: created.id, externalId: send.externalId };
}
