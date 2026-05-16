import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { blobStorage } from "@/lib/blob-storage";
import { MEDIA_SIZE_CAPS, kindFromMime } from "@/lib/media-storage";
import { emitToTeam } from "@/lib/socket/server";
import { parseMentions } from "@/lib/team-chat/mentions";
import {
  buildMessagePreview,
  loadMessageForEmit,
} from "@/lib/team-chat/queries";

/**
 * POST /api/team/channels/[id]/media   multipart/form-data:
 *   - file:        File (binary)
 *   - body:        string (optional — caption)
 *   - clientTempId: string (optional)
 *   - threadRootId: string (optional — post as a thread reply)
 *
 * Same blob pipeline as customer media (lib/blob-storage), no Meta hop —
 * team chat is internal, the file just needs to land in our blob provider
 * and the message row carries the CDN URL.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CAPTION_LENGTH = 4000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const receivedAt = new Date();
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { id: channelId } = await params;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const file = form.get("file");
  const bodyRaw = String(form.get("body") ?? "").trim();
  const body = bodyRaw.slice(0, MAX_CAPTION_LENGTH);
  const clientTempIdRaw = form.get("clientTempId");
  const clientTempId =
    typeof clientTempIdRaw === "string" && clientTempIdRaw ? clientTempIdRaw : undefined;
  const threadRootIdRaw = form.get("threadRootId");
  const threadRootIdInput =
    typeof threadRootIdRaw === "string" && threadRootIdRaw ? threadRootIdRaw : null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }

  const channel = await db.teamChannel.findFirst({
    where: { id: channelId, teamId: session.teamId },
    select: { id: true },
  });
  if (!channel) {
    return NextResponse.json({ error: "channel not found" }, { status: 404 });
  }

  // Validate thread root if provided.
  if (threadRootIdInput) {
    const root = await db.teamChannelMessage.findFirst({
      where: {
        id: threadRootIdInput,
        channelId,
        teamId: session.teamId,
        threadRootId: null,
      },
      select: { id: true },
    });
    if (!root) {
      return NextResponse.json(
        { error: "invalid thread root" },
        { status: 400 },
      );
    }
  }

  const mimeType = file.type || "application/octet-stream";
  const kind = kindFromMime(mimeType);
  const cap = MEDIA_SIZE_CAPS[kind];
  if (file.size > cap) {
    return NextResponse.json(
      { error: `file too large for ${kind}`, cap },
      { status: 413 },
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const filename = file.name || "upload";

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
      // Team chat is internal — "out" isn't meaningful. Use "out" anyway
      // so the blob's dashboard name keeps a consistent shape; agents
      // browsing the dashboard see "<team>/out/<channel>/<file>".
      direction: "out",
      conversationId: channelId,
      externalId: clientTempId ?? `chan_${channelId}`,
      originalFilename: filename,
    },
  });

  // Mention parsing on the caption.
  const parsedMentions = parseMentions(body);
  const mentionIds = Array.from(new Set(parsedMentions.map((m) => m.userId)));
  let validMentionIds: string[] = [];
  if (mentionIds.length > 0) {
    const teamMembers = await db.user.findMany({
      where: { teamId: session.teamId, id: { in: mentionIds } },
      select: { id: true },
    });
    validMentionIds = teamMembers.map((u) => u.id);
  }

  const preview = buildMessagePreview(body, true);
  const created = await db.$transaction(async (tx) => {
    const msg = await tx.teamChannelMessage.create({
      data: {
        channelId,
        teamId: session.teamId,
        authorUserId: session.userId,
        body,
        mediaKind: kind,
        mediaKey: saved.key,
        mediaUrl: saved.url,
        mediaMimeType: mimeType,
        mediaCaption: body || null,
        mediaFilename: kind === "document" ? filename : null,
        mediaSizeBytes: saved.sizeBytes,
        createdAt: receivedAt,
        ...(threadRootIdInput ? { threadRootId: threadRootIdInput } : {}),
      },
      select: { id: true },
    });
    if (validMentionIds.length > 0) {
      await tx.teamChannelMention.createMany({
        data: validMentionIds.map((uid) => ({
          messageId: msg.id,
          mentionedUserId: uid,
        })),
        skipDuplicates: true,
      });
    }
    // Top-level only: bump the channel summary. Replies don't surface in the
    // channel preview.
    if (!threadRootIdInput) {
      await tx.teamChannel.update({
        where: { id: channelId },
        data: { lastMessageAt: receivedAt, lastMessagePreview: preview },
      });
    } else {
      await tx.teamChannelMessage.update({
        where: { id: threadRootIdInput },
        data: {
          threadReplyCount: { increment: 1 },
          threadLastReplyAt: receivedAt,
        },
      });
    }
    return msg;
  });

  const dto = await loadMessageForEmit(created.id, session.teamId);
  if (!dto) {
    return NextResponse.json({ ok: true, messageId: created.id });
  }

  emitToTeam(session.teamId, "team:channel:message", {
    teamId: session.teamId,
    channelId,
    message: dto,
    preview: threadRootIdInput ? null : preview,
    lastMessageAt: threadRootIdInput ? null : receivedAt.toISOString(),
    ...(clientTempId ? { clientTempId } : {}),
  });
  if (threadRootIdInput) {
    emitToTeam(session.teamId, "team:channel:thread:reply", {
      teamId: session.teamId,
      channelId,
      rootMessageId: threadRootIdInput,
      replyCount: dto.threadReplyCount + 1, // best-effort; full reload would race
      lastReplyAt: receivedAt.toISOString(),
    });
  }

  return NextResponse.json({ ok: true, messageId: created.id, message: dto });
}
