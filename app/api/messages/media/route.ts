import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { MEDIA_SIZE_CAPS, kindFromMime } from "@/lib/media-storage";
import { getMetaSendConfig } from "@/lib/providers/config";
import { metaProvider } from "@/lib/providers/meta";
import { MetaSendError } from "@/lib/providers/meta";
import { loadReplySnapshotById, mediaPreview } from "@/lib/providers/ingest";
import { emitToTeam } from "@/lib/socket/server";
import type { MediaAttachment, Message } from "@/lib/types";

/**
 * Outbound media. multipart/form-data:
 *   - conversationId: string
 *   - file: File (binary)
 *   - caption?: string
 *
 * Pipeline:
 *   1) Auth + look up conversation
 *   2) Validate size + classify into a MediaKind from the mime type
 *   3) Upload bytes to Meta /media → mediaId
 *   4) POST /messages with the mediaId
 *   5) Upload the same bytes to our blob provider (UploadThing today) so the
 *      bubble can render the file without asking Meta for it again — Meta's
 *      mediaId is single-use anyway.
 *   6) Insert message row + bump conversation + emit message:new
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // See app/api/messages/route.ts for why we stamp at receive time, not at
  // Meta-completion time — keeps row order aligned with the user's send
  // sequence even when text/media calls return out of order.
  const receivedAt = new Date();
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const conversationId = String(form.get("conversationId") ?? "");
  const caption = String(form.get("caption") ?? "").trim();
  const clientTempIdRaw = form.get("clientTempId");
  const clientTempId =
    typeof clientTempIdRaw === "string" && clientTempIdRaw ? clientTempIdRaw : undefined;
  const replyToMessageIdRaw = form.get("replyToMessageId");
  const replyToMessageIdInput =
    typeof replyToMessageIdRaw === "string" && replyToMessageIdRaw
      ? replyToMessageIdRaw
      : null;
  const file = form.get("file");

  if (!conversationId || !(file instanceof File)) {
    return NextResponse.json(
      { error: "conversationId and file are required" },
      { status: 400 },
    );
  }

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId: session.teamId },
    include: { contact: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  let replyToMessageId: string | null = null;
  let replyToExternalId: string | undefined;
  if (replyToMessageIdInput) {
    const replyToRow = await db.message.findFirst({
      where: { id: replyToMessageIdInput, conversationId, teamId: session.teamId },
      select: { id: true, externalId: true },
    });
    if (replyToRow) {
      replyToMessageId = replyToRow.id;
      if (!replyToRow.externalId.startsWith("tmp_")) {
        replyToExternalId = replyToRow.externalId;
      }
    }
  }

  const mimeType = file.type || "application/octet-stream";
  const kind = kindFromMime(mimeType);
  const cap = MEDIA_SIZE_CAPS[kind];
  if (file.size > cap) {
    return NextResponse.json(
      {
        error: `file too large for ${kind}: ${file.size} bytes > ${cap}`,
        cap,
      },
      { status: 413 },
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const filename = file.name || "upload";

  // Provider config — fail clearly if WhatsApp isn't connected yet.
  let sendConfig;
  try {
    sendConfig = await getMetaSendConfig(session.teamId);
  } catch (err) {
    return NextResponse.json(
      { error: "WhatsApp is not connected for this team", detail: err instanceof Error ? err.message : String(err) },
      { status: 409 },
    );
  }

  // 1) Upload to Meta.
  let mediaId: string;
  try {
    const uploaded = await metaProvider.uploadMedia!(
      { bytes, mimeType, filename },
      sendConfig,
    );
    mediaId = uploaded.mediaId;
  } catch (err) {
    if (err instanceof MetaSendError) {
      return NextResponse.json(
        { error: "meta rejected upload", status: err.httpStatus, detail: err.body },
        { status: 422 },
      );
    }
    throw err;
  }

  // 2) Send the message referencing that mediaId.
  let send;
  try {
    send = await metaProvider.sendMedia!(
      {
        to: conversation.contact.phoneNumber,
        kind,
        mediaId,
        caption: caption || undefined,
        filename: kind === "document" ? filename : undefined,
        ...(replyToExternalId ? { replyToExternalId } : {}),
      },
      sendConfig,
    );
  } catch (err) {
    if (err instanceof MetaSendError) {
      return NextResponse.json(
        { error: "meta rejected send", status: err.httpStatus, detail: err.body },
        { status: 422 },
      );
    }
    throw err;
  }

  // 3) Persist the bytes in our blob provider so we can render the bubble
  //    without going back to Meta. Keyed by the wamid Meta returned. The
  //    filename context lets us scan the UploadThing dashboard and tell who
  //    sent what to whom.
  const teamRow = await db.team.findUnique({
    where: { id: session.teamId },
    select: { name: true },
  });
  const saved = await blobStorage.upload({
    bytes,
    mimeType,
    kind,
    context: {
      teamId: session.teamId,
      teamSlug: teamRow?.name,
      direction: "out",
      contactPhone: conversation.contact.phoneNumber,
      contactName: conversation.contact.name,
      conversationId,
      externalId: send.externalId,
      originalFilename: filename,
    },
  });

  // 4) DB row + conversation summary.
  const previewBody = (caption || mediaPreview(kind)).slice(0, 200);

  const created = await db.message.create({
    data: {
      teamId: session.teamId,
      conversationId,
      externalId: send.externalId,
      senderUserId: session.userId,
      body: caption,
      direction: "out",
      provider: "meta_cloud",
      status: "sent",
      rawPayload: { sentVia: "api/messages/media", mediaId } as Prisma.InputJsonValue,
      timestamp: receivedAt,
      mediaKind: kind,
      mediaKey: saved.key,
      mediaUrl: saved.url,
      mediaMimeType: mimeType,
      mediaCaption: caption || null,
      mediaFilename: kind === "document" ? filename : null,
      mediaSizeBytes: saved.sizeBytes,
      ...(replyToMessageId ? { replyToMessageId } : {}),
    },
  });

  await db.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: send.timestamp, lastMessagePreview: previewBody },
  });

  const media: MediaAttachment = {
    kind,
    url: `/api/media/${created.id}`,
    mimeType,
    sizeBytes: saved.sizeBytes,
    ...(caption ? { caption } : {}),
    ...(kind === "document" ? { filename } : {}),
  };

  const replySnapshot = replyToMessageId
    ? await loadReplySnapshotById(replyToMessageId)
    : null;

  const message: Message = {
    id: created.id,
    teamId: session.teamId,
    conversationId,
    externalId: send.externalId,
    senderUserId: session.userId,
    body: caption,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: { sentVia: "api/messages/media", mediaId },
    timestamp: receivedAt.toISOString(),
    media,
    ...(replyToMessageId
      ? { replyToMessageId, replyTo: replySnapshot ?? null }
      : {}),
  };

  emitToTeam(session.teamId, "message:new", {
    teamId: session.teamId,
    conversationId,
    message,
    preview: previewBody,
    lastMessageAt: send.timestamp.toISOString(),
    unreadDelta: 0,
    ...(clientTempId ? { clientTempId } : {}),
  });

  return NextResponse.json({ ok: true, messageId: created.id });
}
