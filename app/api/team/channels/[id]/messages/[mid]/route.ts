import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";
import { parseMentions } from "@/lib/team-chat/mentions";
import {
  canDeleteMessage,
  canEditMessage,
  EDIT_WINDOW_MS,
} from "@/lib/team-chat/permissions";
import { buildMessagePreview, loadMessageForEmit } from "@/lib/team-chat/queries";

/**
 * PATCH  /api/team/channels/[id]/messages/[mid]   { body }   — author-only edit
 * DELETE /api/team/channels/[id]/messages/[mid]              — author or admin
 *
 * Edits are time-limited (see EDIT_WINDOW_MS). Body is rewritten in place;
 * the prior body is not retained. Mention rows are reconciled to match the
 * new body. The denormalized channel preview is refreshed only when the
 * edited message is currently the channel's latest message.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_LENGTH = 4000;

interface PatchBody {
  body?: unknown;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { id: channelId, mid: messageId } = await params;

  let raw: PatchBody;
  try {
    raw = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!body) {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }
  if (body.length > MAX_BODY_LENGTH) {
    return NextResponse.json({ error: "body too long" }, { status: 413 });
  }

  const existing = await db.teamChannelMessage.findFirst({
    where: { id: messageId, channelId, teamId: session.teamId },
    select: {
      id: true,
      authorUserId: true,
      createdAt: true,
      threadRootId: true,
      mediaKind: true,
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "message not found" }, { status: 404 });
  }
  if (!canEditMessage(existing.authorUserId, session.userId, existing.createdAt)) {
    // Distinguish "you're not the author" from "edit window closed" — the UI
    // can hide the menu in both cases but the error code helps the rare
    // race where a stale tab tries an edit just past the window.
    if (existing.authorUserId !== session.userId) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return NextResponse.json(
      {
        error: "edit_window_closed",
        detail: `Messages can be edited for ${Math.round(EDIT_WINDOW_MS / 1000 / 60 / 60)} hours after sending.`,
      },
      { status: 422 },
    );
  }

  // Refresh mention rows + body in one transaction. Replace-all is simpler
  // than diff'ing — the upper bound on mentions per message is small.
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

  const editedAt = new Date();
  await db.$transaction([
    db.teamChannelMessage.update({
      where: { id: messageId },
      data: { body, editedAt },
    }),
    db.teamChannelMention.deleteMany({ where: { messageId } }),
    ...(validMentionIds.length > 0
      ? [
          db.teamChannelMention.createMany({
            data: validMentionIds.map((uid) => ({
              messageId,
              mentionedUserId: uid,
            })),
            skipDuplicates: true,
          }),
        ]
      : []),
  ]);

  // Refresh channel preview if this is currently the latest top-level
  // message. Skip for thread replies (they don't surface in the preview).
  if (existing.threadRootId === null) {
    const latest = await db.teamChannelMessage.findFirst({
      where: { channelId, threadRootId: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, body: true, mediaKind: true },
    });
    if (latest?.id === messageId) {
      await db.teamChannel.update({
        where: { id: channelId },
        data: {
          lastMessagePreview: buildMessagePreview(body, !!existing.mediaKind),
        },
      });
    }
  }

  emitToTeam(session.teamId, "team:channel:message:edited", {
    teamId: session.teamId,
    channelId,
    messageId,
    body,
    editedAt: editedAt.toISOString(),
  });

  const dto = await loadMessageForEmit(messageId, session.teamId);
  return NextResponse.json({ ok: true, message: dto });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { id: channelId, mid: messageId } = await params;

  const existing = await db.teamChannelMessage.findFirst({
    where: { id: messageId, channelId, teamId: session.teamId },
    select: {
      id: true,
      authorUserId: true,
      threadRootId: true,
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "message not found" }, { status: 404 });
  }
  if (!canDeleteMessage(session.role, existing.authorUserId, session.userId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await db.teamChannelMessage.delete({ where: { id: messageId } });

  // If we deleted a thread reply, decrement the root's counter so the
  // "X replies" pill stays honest.
  if (existing.threadRootId) {
    await db.teamChannelMessage
      .update({
        where: { id: existing.threadRootId },
        data: { threadReplyCount: { decrement: 1 } },
      })
      .catch((err) =>
        console.error("[team-chat] decrement threadReplyCount failed", err),
      );
  } else {
    // Top-level delete: refresh the channel preview to whatever's now
    // latest. If the channel is now empty, fall back to an empty preview.
    const latest = await db.teamChannelMessage.findFirst({
      where: { channelId, threadRootId: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { body: true, mediaKind: true, createdAt: true },
    });
    await db.teamChannel.update({
      where: { id: channelId },
      data: latest
        ? {
            lastMessageAt: latest.createdAt,
            lastMessagePreview: buildMessagePreview(latest.body, !!latest.mediaKind),
          }
        : { lastMessagePreview: "" },
    });
  }

  emitToTeam(session.teamId, "team:channel:message:deleted", {
    teamId: session.teamId,
    channelId,
    messageId,
    threadRootId: existing.threadRootId,
  });

  return NextResponse.json({ ok: true });
}
