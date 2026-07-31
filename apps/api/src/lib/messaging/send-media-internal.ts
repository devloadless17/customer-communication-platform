// Server-side outbound AUDIO sender — mirrors sendTextInternal for media, used
// by the AI Assistant to deliver a generated TTS voice note. Same channel /
// 24h-window / commitOutboundSend flow as text; the only difference is storing
// the mp3 in R2 and delivering it via the provider's media path (upload-based
// for WhatsApp, URL-based for channels with `mediaSendByUrl`).
//
// Throws on any failure so the caller can fall back to a text reply
// (correction: fall back to text when TTS or media sending fails).

import { Prisma } from "@prisma/client";

import { blobStorage } from "@/lib/blob-storage";
import { db } from "@/lib/db";
import { transcodeToM4a, transcodeToOggOpus } from "@/lib/media/audio-transcode";
import { commitOutboundSend } from "@/lib/messaging/commit-outbound-send";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getProviderBinding, requireProviderMethod } from "@/lib/providers";
import { NoChannelDestinationError, resolveContactChannel } from "@/lib/providers/channel";
import { ProviderNotConfiguredError } from "@/lib/providers/config";
import type { Message } from "@ccp/shared/types";
import {
  computeWindowStatus,
  effectiveSendWindowMs,
  outsideFreeFormWindow,
} from "@ccp/shared/utils/window";

export interface SendMediaInternalArgs {
  workspaceId: string;
  conversationId: string;
  bytes: Uint8Array;
  mimeType: string; // e.g. "audio/mpeg"
  filename: string; // e.g. "voice.mp3"
  voice: boolean; // WhatsApp voice-note flag
  caption?: string;
  /** Deterministic, tenant-prefixed R2 key (dedup — same reply => same key). */
  blobKey: string;
  sentVia: string;
  durationMs?: number;
}

export interface SendMediaInternalResult {
  messageId: string;
  externalId: string;
}

export async function sendMediaInternal(
  args: SendMediaInternalArgs,
): Promise<SendMediaInternalResult> {
  const receivedAt = new Date();

  const conversation = await db.conversation.findFirst({
    where: { id: args.conversationId, workspaceId: args.workspaceId },
    select: {
      id: true,
      contactId: true,
      // The account this thread belongs to — sends must go out from it.
      channelConnectionId: true,
      channel: true,
      lastMessageAt: true,
      contact: {
        select: {
          phoneNumber: true,
          identityChannel: true,
          externalContactId: true,
          lastInboundAt: true,
          blockedAt: true,
        },
      },
    },
  });
  if (!conversation) throw new Error("conversation_not_found");
  // Provider-level block: Meta rejects every send to a blocked contact —
  // refuse up front (same code the sibling internals throw).
  if (conversation.contact.blockedAt) throw new Error("contact_blocked");

  let channel;
  try {
    channel = resolveContactChannel(conversation.contact);
  } catch (err) {
    if (err instanceof NoChannelDestinationError) throw new Error("contact_has_no_address");
    throw err;
  }
  const provider = conversation.channel;
  const binding = getProviderBinding(provider);

  const lastInboundAt = conversation.contact.lastInboundAt?.toISOString() ?? null;

  // Free-form window gate (same as text) — voice replies must respect it.
  const windowMs = effectiveSendWindowMs(binding.provider.capabilities);
  if (windowMs !== null) {
    const win = computeWindowStatus(lastInboundAt, Date.now(), windowMs);
    if (win.state === "closed" || win.state === "never") throw new Error("outside_24h_window");
  }
  const useHumanAgentTag = outsideFreeFormWindow(
    binding.provider.capabilities.freeFormWindowMs,
    lastInboundAt,
  );

  let sendConfig;
  try {
    sendConfig = await binding.getSendConfig(args.workspaceId, conversation.channelConnectionId);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) throw new Error("provider_not_configured");
    throw err;
  }

  // Voice notes need a per-channel audio container or they won't download/play:
  // WhatsApp/Messenger require ogg/opus (an mp3 voice note shows "Couldn't
  // download audio" on iOS), and Instagram's URL fetcher needs m4a. TTS hands us
  // mp3, so transcode to match the channel — mirrors the human-send path in
  // messages.service.ts. Best-effort: on a transcode failure keep the mp3 (the
  // api image ships ffmpeg, so this only bites in a bare local dev host).
  let sendBytes = args.bytes;
  let sendMime = args.mimeType;
  let sendName = args.filename;
  if (args.voice) {
    try {
      if (binding.provider.capabilities.mediaSendByUrl) {
        sendBytes = await transcodeToM4a(args.bytes);
        sendMime = "audio/mp4";
        sendName = "voice.m4a";
      } else {
        sendBytes = await transcodeToOggOpus(args.bytes);
        sendMime = "audio/ogg";
        sendName = "voice.ogg";
      }
    } catch {
      // Keep the original mp3 bytes/mime/name (ffmpeg missing or failed).
    }
  }

  // Store the send-ready bytes in R2 (deterministic key). putObject skips the
  // media magic-byte sniff — these are first-party generated bytes.
  const saved = await blobStorage.putObject({
    key: args.blobKey,
    bytes: sendBytes,
    contentType: sendMime,
  });

  // Deliver: upload-based (WhatsApp) → Meta media id; URL-based (IG) → presigned
  // R2 url. requireProviderMethod throws if the channel can't send media.
  const sendMedia = requireProviderMethod(binding.provider, "sendMedia", provider);
  let mediaId = "";
  let mediaUrl: string | undefined;
  if (binding.provider.capabilities.mediaSendByUrl) {
    mediaUrl = await blobStorage.presignGetUrl(saved.key, { ttlSeconds: 3600 });
  } else {
    const uploadMedia = requireProviderMethod(binding.provider, "uploadMedia", provider);
    const up = await uploadMedia(
      { bytes: sendBytes, mimeType: sendMime, filename: sendName },
      sendConfig,
    );
    mediaId = up.mediaId;
  }

  const send = await sendMedia(
    {
      to: channel.to,
      ...(channel.viaBsuid ? { viaBsuid: true } : {}),
      kind: "audio",
      mediaId,
      ...(mediaUrl ? { mediaUrl } : {}),
      voice: args.voice,
      useHumanAgentTag,
      ...(args.caption ? { caption: args.caption } : {}),
    },
    sendConfig,
  );

  const lastTs = conversation.lastMessageAt ?? null;
  const messageTimestamp =
    lastTs && lastTs >= receivedAt ? new Date(lastTs.getTime() + 1) : receivedAt;

  const created = await createOutboundMessageIdempotent({
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: null,
    body: args.caption ?? "",
    direction: "out",
    channel: provider,
    status: "sent",
    rawPayload: { sentVia: args.sentVia, mediaId } as Prisma.InputJsonValue,
    timestamp: messageTimestamp,
    mediaKind: "audio",
    mediaMimeType: sendMime,
    mediaKey: saved.key,
    mediaUrl: saved.url,
    mediaSizeBytes: saved.sizeBytes,
    mediaVoice: args.voice,
    mediaDurationMs: args.durationMs ?? null,
    mediaCaption: args.caption ?? null,
  });

  const preview = args.caption?.slice(0, 200) || "Voice message";
  const message: Message = {
    id: created.id,
    workspaceId: args.workspaceId,
    conversationId: args.conversationId,
    externalId: send.externalId,
    senderUserId: null,
    body: args.caption ?? "",
    direction: "out",
    channel: provider,
    status: "sent",
    rawPayload: { sentVia: args.sentVia, mediaId },
    timestamp: messageTimestamp.toISOString(),
    media: {
      kind: "audio",
      url: `/api/media/${created.id}`,
      mimeType: sendMime,
      sizeBytes: saved.sizeBytes,
      voice: args.voice,
      ...(args.durationMs ? { durationMs: args.durationMs } : {}),
      ...(args.caption ? { caption: args.caption } : {}),
    },
  };

  await commitOutboundSend({
    conversationId: args.conversationId,
    bumpTimestamp: messageTimestamp,
    preview,
    event: {
      type: "message.sent",
      workspaceId: args.workspaceId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      message,
      preview,
      senderUserId: null,
    },
    onMissing: () => {
      throw new Error("conversation_disappeared_mid_send");
    },
  });

  return { messageId: created.id, externalId: send.externalId };
}
