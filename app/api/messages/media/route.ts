import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { MEDIA_SIZE_CAPS, kindFromMime } from "@/lib/media-storage";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig } from "@/lib/providers/config";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import { loadReplySnapshotById, mediaPreview } from "@/lib/providers/ingest";
import { emitToTeam } from "@/lib/socket/server";
import type { MediaAttachment, Message } from "@/lib/types";
import { computeWindowStatus } from "@/lib/window";

/**
 * Outbound media. multipart/form-data:
 *   - conversationId: string
 *   - file: File (binary)
 *   - caption?: string
 *
 * Pipeline:
 *   1) Auth + look up conversation
 *   2) Validate size + classify into a MediaKind from the mime type
 *   3) IN PARALLEL: upload bytes to Meta /media AND upload to our blob provider
 *      (UploadThing today). Both consume only the in-memory bytes — running
 *      them concurrently halves the critical path. The blob lets the bubble
 *      render without asking Meta for the file again (Meta's mediaId is
 *      single-use anyway). Blob's dashboard filename is keyed by clientTempId
 *      (or a generated id) since the wamid doesn't exist yet — pure metadata,
 *      not used for retrieval.
 *   4) POST /messages with the mediaId
 *   5) Insert message row + bump conversation + emit message:new
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

  // 24h window pre-check. Media (like free-form text) is rejected outside the
  // window — only templates work there. Bailing here saves the Meta upload +
  // send round-trips and the disk-to-Meta byte transfer when the agent
  // genuinely can't reach this contact without a template.
  const lastInbound = await db.message.findFirst({
    where: { conversationId, direction: "in" },
    orderBy: { timestamp: "desc" },
    select: { timestamp: true },
  });
  const win = computeWindowStatus(lastInbound?.timestamp.toISOString() ?? null);
  if (win.state === "closed" || win.state === "never") {
    return NextResponse.json(
      {
        error: "outside_24h_window",
        detail:
          "24-hour window closed — media can't be sent freely. Use an approved template to re-engage.",
        lastInboundAt: lastInbound?.timestamp.toISOString() ?? null,
      },
      { status: 422 },
    );
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

  // Run in parallel: Meta `/media` upload AND our blob provider upload. Both
  // pure functions of `bytes`, no ordering needed. Critical path was the sum
  // of both — now it's the max. We also kick off the team lookup that the
  // blob context needs at the same time so it never serializes the upload.
  const blobLabelId = clientTempId ?? randomUUID();
  const teamRowPromise = db.team
    .findUnique({
      where: { id: session.teamId },
      select: { name: true },
    })
    .catch(() => null);

  const blobUploadPromise = (async () => {
    const teamRow = await teamRowPromise;
    return blobStorage.upload({
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
        // No wamid yet — Meta hasn't returned one. Use the client temp id (or
        // a generated uuid) so the dashboard filename is still unique and
        // traceable. Not used for retrieval — purely metadata.
        externalId: blobLabelId,
        originalFilename: filename,
      },
    });
  })();

  // 1) Upload to Meta. Pre-send phase: throwing here is safe because the
  //    message hasn't gone out yet — the agent retries cleanly with no risk
  //    of a duplicate on the customer's WhatsApp.
  let mediaId: string;
  try {
    const uploaded = await getMetaProvider().uploadMedia!(
      { bytes, mimeType, filename },
      sendConfig,
    );
    mediaId = uploaded.mediaId;
  } catch (err) {
    // Don't let the parallel blob upload leak as an unhandledRejection on the
    // early-return path — the upload may still be in flight when we bail.
    blobUploadPromise.catch(() => {});
    const normalized = normalizeMetaSendError(err);
    if (normalized) {
      return NextResponse.json(
        {
          error: normalized.code,
          message: normalized.message,
          status: normalized.httpStatus,
          detail: normalized.detail,
        },
        { status: 422 },
      );
    }
    throw err;
  }

  // 2) Send the message referencing that mediaId. Same logic — throwing pre-
  //    send is fine. After this line returns, Meta has accepted the send and
  //    the customer has (or will shortly) receive the message.
  let send;
  try {
    send = await getMetaProvider().sendMedia!(
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
    blobUploadPromise.catch(() => {});
    const normalized = normalizeMetaSendError(err);
    if (normalized) {
      return NextResponse.json(
        {
          error: normalized.code,
          message: normalized.message,
          status: normalized.httpStatus,
          detail: normalized.detail,
        },
        { status: 422 },
      );
    }
    throw err;
  }

  // ── Post-send: Meta has accepted. From here, NOTHING is allowed to throw
  // back to the agent. Throwing would return 5xx → the inbox retries → Meta
  // accepts the second send → the customer gets the same media twice. Worst
  // case here is a degraded row (no local media URL) that the inbox renders
  // as "media unavailable", which is strictly better than a duplicate send.

  // 3) Wait for the parallel blob upload kicked off above. Wrapped: a blob-
  //    provider outage must not block the DB row that records the (already-
  //    sent) message.
  let saved: { key: string; url: string; sizeBytes: number } | null = null;
  try {
    saved = await blobUploadPromise;
  } catch (err) {
    console.error(
      `[api/messages/media] blob upload failed AFTER successful Meta send (wamid=${send.externalId}); persisting row without local media to avoid duplicate retry`,
      err,
    );
  }

  // 4) DB row + conversation summary. Both wrapped so even a DB hiccup right
  //    here doesn't lead to a 5xx the agent will retry. The message is "lost"
  //    locally if this fails, but the customer already got it on WhatsApp.
  const previewBody = (caption || mediaPreview(kind)).slice(0, 200);

  const created = await createOutboundMessageIdempotent({
    teamId: session.teamId,
    conversationId,
    externalId: send.externalId,
    senderUserId: session.userId,
    body: caption,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: {
      sentVia: "api/messages/media",
      mediaId,
      ...(saved ? {} : { blobUploadFailed: true }),
    } as Prisma.InputJsonValue,
    timestamp: receivedAt,
    // Persist media columns only when the blob upload succeeded. mediaKind
    // and mediaMimeType were previously written unconditionally — the bug
    // was that mapMessage (lib/queries/_shared.ts) treats `mediaKind &&
    // !mediaUrl` as "still downloading" and renders the inbound pending
    // placeholder. Outbound has no background-download path, so that state
    // would persist across reloads as a stuck "Downloading photo…" spinner.
    // When the blob failed, leave the row as text-only — the caption is
    // already in `body` so the bubble still renders.
    ...(saved
      ? {
          mediaKind: kind,
          mediaMimeType: mimeType,
          mediaCaption: caption || null,
          mediaFilename: kind === "document" ? filename : null,
          mediaKey: saved.key,
          mediaUrl: saved.url,
          mediaSizeBytes: saved.sizeBytes,
        }
      : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
  }).catch((err): null => {
    console.error(
      `[api/messages/media] DB persist failed AFTER successful Meta send (wamid=${send.externalId})`,
      err,
    );
    return null;
  });

  if (!created) {
    // Still return 200 — the message went out. Don't tempt the agent into
    // retrying. The row is missing locally, which is the lesser evil vs a
    // duplicate send to the customer.
    return NextResponse.json({
      ok: true,
      messageId: null,
      warning: "message sent but local persistence failed",
    });
  }
  const createdId = created.id;

  // Conversation summary bump is also best-effort; the live socket emit
  // below carries everything an active client needs for the inbox list.
  void db.conversation
    .update({
      where: { id: conversationId },
      data: { lastMessageAt: send.timestamp, lastMessagePreview: previewBody },
    })
    .catch((err) =>
      console.error("[api/messages/media] deferred conversation.update failed", err),
    );

  const media: MediaAttachment | undefined = saved
    ? {
        kind,
        url: `/api/media/${createdId}`,
        mimeType,
        sizeBytes: saved.sizeBytes,
        ...(caption ? { caption } : {}),
        ...(kind === "document" ? { filename } : {}),
      }
    : undefined;

  const replySnapshot = replyToMessageId
    ? await loadReplySnapshotById(replyToMessageId).catch(() => null)
    : null;

  const message: Message = {
    id: createdId,
    teamId: session.teamId,
    conversationId,
    externalId: send.externalId,
    senderUserId: session.userId,
    body: caption,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: {
      sentVia: "api/messages/media",
      mediaId,
      ...(saved ? {} : { blobUploadFailed: true }),
    },
    timestamp: receivedAt.toISOString(),
    ...(media ? { media } : {}),
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

  return NextResponse.json({
    ok: true,
    messageId: createdId,
    ...(saved ? {} : { warning: "message sent but media file could not be archived locally" }),
  });
}
