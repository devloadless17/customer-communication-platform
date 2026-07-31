import { Prisma } from "@prisma/client";

import { blobStorage } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import { commitOutboundSend } from "@/lib/messaging/commit-outbound-send";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { fetchUrlBytes, withMediaDownloadSlot } from "@/lib/media-capture";
import { mediaPolicyForChannel } from "@/lib/media-storage";
import { getProviderBinding, requireProviderMethod } from "@/lib/providers";
import {
  NoChannelDestinationError,
  resolveContactChannel,
} from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import type { Message } from "@ccp/shared/types";
import {
  computeWindowStatus,
  closedWindowMessage,
  effectiveSendWindowMs,
  outsideFreeFormWindow,
} from "@ccp/shared/utils/window";

import { SendTextValidationError } from "./send-text-internal";

/**
 * Send a first-party STICKER (Messenger's Sticker API).
 *
 * Sibling of `sendStructuredInternal`: same window gate, same provider-config
 * resolution, same idempotent create and the same atomic `message.sent` commit.
 * Two things are specific to stickers.
 *
 * ## 1. The image is CAPTURED, not linked
 *
 * The catalog hands back an `scontent.xx.fbcdn.net` URL that EXPIRES. Persisting
 * it would leave a broken image in the thread weeks later — history that rots
 * silently, which is worse than no picture at all. So the bytes are pulled into
 * R2 at send time through the same SSRF-safe, slot-bounded path inbound media
 * uses (`@/lib/media-capture`), and the row stores OUR key.
 *
 * The capture is best-effort on purpose. If it fails, the message has ALREADY
 * been delivered to the customer — Meta accepted it and returned a mid — so
 * refusing to write the row would lose a sent message from the agent's own
 * thread. The row is written either way; only the picture is missing, and the
 * body label carries the meaning.
 *
 * ## 2. Stickers are window-gated like any other message
 *
 * Meta: "Stickers can only be sent within the standard messaging window,
 * following the same rules as other Send API message types." So this uses the
 * identical gate as text — deliberately NOT the utility-template path, which
 * bypasses the window by design.
 */
export interface SendStickerInternalArgs {
  workspaceId: string;
  conversationId: string;
  stickerId: string;
  /** Catalog image URL, when the caller has one. Captured to R2 best-effort. */
  imageUrl?: string;
  senderUserId?: string | null;
  senderApiKeyId?: string | null;
  sentVia: string;
}

export interface SendStickerInternalResult {
  messageId: string;
  externalId: string;
}

export async function sendStickerInternal(
  args: SendStickerInternalArgs,
): Promise<SendStickerInternalResult> {
  const receivedAt = new Date();

  const conversation = await db.conversation.findFirst({
    where: { id: args.conversationId, workspaceId: args.workspaceId },
    select: {
      id: true,
      contactId: true,
      channelConnectionId: true,
      channel: true,
      lastMessageAt: true,
      contact: {
        select: {
          phoneNumber: true,
          identityChannel: true,
          externalContactId: true,
          // Every ChannelResolvable select carries bsuid so a BSUID-only
          // WhatsApp thread (username adopter) resolves instead of throwing.
          bsuid: true,
          lastInboundAt: true,
          blockedAt: true,
        },
      },
    },
  });
  if (!conversation) {
    throw new SendTextValidationError("conversation_not_found", "conversation not found");
  }
  if (conversation.contact.blockedAt) {
    throw new SendTextValidationError(
      "contact_blocked",
      "contact_blocked",
      "This contact is blocked. Unblock them to send messages.",
    );
  }

  let dest;
  try {
    dest = resolveContactChannel(conversation.contact);
  } catch (err) {
    if (err instanceof NoChannelDestinationError) {
      throw new SendTextValidationError("contact_has_no_phone", "contact has no reachable address");
    }
    throw err;
  }
  const provider = conversation.channel;
  const binding = getProviderBinding(provider);

  let sendSticker;
  try {
    sendSticker = requireProviderMethod(binding.provider, "sendSticker", provider);
  } catch {
    throw new SendTextValidationError(
      "provider_not_configured",
      "stickers_not_supported",
      `${provider} can't send stickers.`,
    );
  }

  // Same free-form window gate as text — see the docblock.
  const windowMs = effectiveSendWindowMs(binding.provider.capabilities);
  const lastInboundIso = conversation.contact.lastInboundAt?.toISOString() ?? null;
  if (windowMs !== null) {
    const win = computeWindowStatus(lastInboundIso, Date.now(), windowMs);
    if (win.state === "closed" || win.state === "never") {
      throw new SendTextValidationError(
        "outside_24h_window",
        "outside_24h_window",
        closedWindowMessage(binding.provider.capabilities),
      );
    }
  }
  const useHumanAgentTag = outsideFreeFormWindow(
    binding.provider.capabilities.freeFormWindowMs,
    lastInboundIso,
  );

  let sendConfig;
  try {
    sendConfig = await binding.getSendConfig(args.workspaceId, conversation.channelConnectionId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      throw new SendTextValidationError("provider_not_configured", "channel_not_connected", err.message);
    }
    throw err;
  }

  const send = await sendSticker(
    { to: dest.to, ...(dest.viaBsuid ? { viaBsuid: true } : {}), stickerId: args.stickerId, useHumanAgentTag },
    sendConfig,
  );

  // Capture the image AFTER the send. Order matters: the send is the billed,
  // customer-visible action and must not be delayed or blocked by our archiving.
  const captured = args.imageUrl
    ? await captureSticker(args.workspaceId, args.imageUrl, provider, dest.to)
    : null;

  const lastTs = conversation.lastMessageAt ?? null;
  const messageTimestamp =
    lastTs && lastTs >= receivedAt ? new Date(lastTs.getTime() + 1) : receivedAt;

  // The body doubles as the list preview and the search text, and is what the
  // bubble falls back to when the capture failed.
  const body = "🙂 Sticker";
  const rawPayload = { sentVia: args.sentVia, stickerId: args.stickerId };

  const created = await createOutboundMessageIdempotent({
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: args.senderUserId ?? null,
    body,
    direction: "out",
    channel: provider,
    status: "sent",
    rawPayload: rawPayload as Prisma.InputJsonValue,
    timestamp: messageTimestamp,
    ...(captured
      ? {
          mediaKind: "sticker" as const,
          mediaMimeType: captured.mimeType,
          mediaKey: captured.storageKey,
          mediaUrl: captured.storageUrl,
          mediaSizeBytes: captured.sizeBytes,
        }
      : {}),
  });

  const senderUserId = args.senderUserId ?? null;
  const message: Message = {
    id: created.id,
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId,
    body,
    direction: "out",
    channel: provider,
    status: "sent",
    timestamp: messageTimestamp.toISOString(),
    ...(captured
      ? {
          media: {
            kind: "sticker" as const,
            // Served through our own route so the workspace-ownership check runs
            // before the redirect to R2 — never a bare bucket URL.
            url: `/api/media/${created.id}`,
            mimeType: captured.mimeType,
            sizeBytes: captured.sizeBytes,
          },
        }
      : {}),
  };

  await commitOutboundSend({
    conversationId: args.conversationId,
    bumpTimestamp: messageTimestamp,
    preview: body,
    event: {
      type: "message.sent",
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      message,
      preview: body,
      senderUserId,
      ...(args.senderApiKeyId ? { senderApiKeyId: args.senderApiKeyId } : {}),
    },
    onMissing: () => {
      throw new SendTextValidationError(
        "conversation_not_found",
        "conversation_disappeared_mid_send",
      );
    },
  });

  return { messageId: created.id, externalId: send.externalId };
}

/**
 * Pull the sticker image into R2. Returns null on any failure — see the
 * docblock: the message is already delivered, so a capture failure costs the
 * picture, never the row.
 */
async function captureSticker(
  workspaceId: string,
  imageUrl: string,
  channel: Parameters<typeof mediaPolicyForChannel>[0],
  contactId: string,
): Promise<{
  storageKey: string;
  storageUrl: string;
  sizeBytes: number;
  mimeType: string;
} | null> {
  try {
    const cap = mediaPolicyForChannel(channel).caps.sticker;
    const fetched = await withMediaDownloadSlot(() => fetchUrlBytes(imageUrl, cap));
    const team = await db.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    });
    // Meta's stickers are webp everywhere, and the mime guard only accepts
    // image/webp for kind `sticker` — so trust the kind over a CDN content-type
    // that occasionally arrives as octet-stream.
    const storeMime = fetched.mimeType.startsWith("image/") ? fetched.mimeType : "image/webp";
    const saved = await blobStorage.upload({
      bytes: fetched.bytes,
      mimeType: storeMime,
      kind: "sticker",
      context: {
        workspaceId,
        teamSlug: team?.name,
        direction: "out",
        contactPhone: contactId,
        externalId: `sticker:${Date.now()}`,
        originalFilename: null,
      },
    });
    return {
      storageKey: saved.key,
      storageUrl: saved.url,
      sizeBytes: fetched.bytes.length,
      mimeType: storeMime,
    };
  } catch {
    return null;
  }
}
