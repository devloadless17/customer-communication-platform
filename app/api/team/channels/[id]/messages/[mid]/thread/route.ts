import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitToChannelThread, emitToTeam } from "@/lib/socket/server";
import { parseMentions } from "@/lib/team-chat/mentions";
import { listThreadReplies, loadMessageForEmit } from "@/lib/team-chat/queries";

/**
 * GET  /api/team/channels/[id]/messages/[mid]/thread     — list replies
 * POST /api/team/channels/[id]/messages/[mid]/thread     — post a reply
 *
 * Replies live in `TeamChannelMessage` with `threadRootId` set. The route
 * enforces "no nested threads" by refusing to take a root id that itself
 * has a non-null threadRootId.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_LENGTH = 4000;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { id: channelId, mid: rootMessageId } = await params;

  // Tenant guard via the root: if the root isn't in this team's channel,
  // the user has no business pulling its replies.
  const root = await db.teamChannelMessage.findFirst({
    where: {
      id: rootMessageId,
      channelId,
      teamId: session.teamId,
    },
    select: { id: true, threadRootId: true },
  });
  if (!root) {
    return NextResponse.json({ error: "thread not found" }, { status: 404 });
  }
  if (root.threadRootId !== null) {
    return NextResponse.json(
      { error: "not_a_thread_root", detail: "Replies cannot themselves host threads." },
      { status: 400 },
    );
  }

  const items = await listThreadReplies(rootMessageId, session.teamId);
  return NextResponse.json({ items });
}

interface PostBody {
  body?: unknown;
  clientTempId?: unknown;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  const receivedAt = new Date();
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { id: channelId, mid: rootMessageId } = await params;

  let raw: PostBody;
  try {
    raw = (await req.json()) as PostBody;
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
  const clientTempId = typeof raw.clientTempId === "string" ? raw.clientTempId : undefined;

  // Validate the root: same channel/team, and itself a top-level message.
  const root = await db.teamChannelMessage.findFirst({
    where: {
      id: rootMessageId,
      channelId,
      teamId: session.teamId,
    },
    select: { id: true, threadRootId: true, threadReplyCount: true },
  });
  if (!root) {
    return NextResponse.json({ error: "thread not found" }, { status: 404 });
  }
  if (root.threadRootId !== null) {
    return NextResponse.json(
      { error: "not_a_thread_root", detail: "Replies cannot themselves host threads." },
      { status: 400 },
    );
  }

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

  const reply = await db.$transaction(async (tx) => {
    const created = await tx.teamChannelMessage.create({
      data: {
        channelId,
        teamId: session.teamId,
        authorUserId: session.userId,
        body,
        threadRootId: rootMessageId,
        createdAt: receivedAt,
      },
      select: { id: true },
    });
    if (validMentionIds.length > 0) {
      await tx.teamChannelMention.createMany({
        data: validMentionIds.map((uid) => ({
          messageId: created.id,
          mentionedUserId: uid,
        })),
        skipDuplicates: true,
      });
    }
    await tx.teamChannelMessage.update({
      where: { id: rootMessageId },
      data: {
        threadReplyCount: { increment: 1 },
        threadLastReplyAt: receivedAt,
      },
    });
    return created;
  });

  const dto = await loadMessageForEmit(reply.id, session.teamId);
  if (!dto) {
    console.error("[team-chat] post-write thread reload returned null");
    return NextResponse.json({ ok: true, messageId: reply.id });
  }

  // Two emits: the team-wide bump (for the channel-list "X replies" pill +
  // any open channel feed showing the reply count badge), and a thread-room
  // emit so subscribers to the side panel see the new reply.
  emitToTeam(session.teamId, "team:channel:message", {
    teamId: session.teamId,
    channelId,
    message: dto,
    preview: null,
    lastMessageAt: null,
    ...(clientTempId ? { clientTempId } : {}),
  });
  emitToTeam(session.teamId, "team:channel:thread:reply", {
    teamId: session.teamId,
    channelId,
    rootMessageId,
    replyCount: root.threadReplyCount + 1,
    lastReplyAt: receivedAt.toISOString(),
  });
  emitToChannelThread(rootMessageId, "team:channel:message", {
    teamId: session.teamId,
    channelId,
    message: dto,
    preview: null,
    lastMessageAt: null,
    ...(clientTempId ? { clientTempId } : {}),
  });

  return NextResponse.json({ ok: true, messageId: reply.id, message: dto });
}
