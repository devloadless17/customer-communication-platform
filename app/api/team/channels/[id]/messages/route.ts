import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { emitToTeam } from "@/lib/socket/server";
import { parseMentions } from "@/lib/team-chat/mentions";
import {
  buildMessagePreview,
  decodeCursor,
  listChannelMessages,
  listChannelMessagesAfter,
  loadMessageForEmit,
} from "@/lib/team-chat/queries";

/**
 * GET  /api/team/channels/[id]/messages?before=<cursor>&take=50
 * GET  /api/team/channels/[id]/messages?after=<iso>            (backfill)
 * POST /api/team/channels/[id]/messages  { body, clientTempId?, mentions?: string[] }
 *
 * `mentions` is the OPTIONAL list of user ids the client knows it tagged —
 * we re-parse the body server-side and INTERSECT with this list so the
 * client can't fan out mentions to users it didn't actually @-tag (audit
 * cleanliness, not a security boundary; the body itself is authoritative).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { id: channelId } = await params;

  // Tenant guard before touching messages — keeps a not-found vs forbidden
  // distinction (both surface as 404 to the client, but the log is honest).
  const channel = await db.teamChannel.findFirst({
    where: { id: channelId, teamId: session.teamId },
    select: { id: true },
  });
  if (!channel) {
    return NextResponse.json({ error: "channel not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const after = url.searchParams.get("after");
  if (after) {
    if (Number.isNaN(Date.parse(after))) {
      return NextResponse.json({ error: "invalid after" }, { status: 400 });
    }
    const items = await listChannelMessagesAfter(channelId, session.teamId, after);
    return NextResponse.json({ items });
  }

  const cursor = url.searchParams.get("before");
  const takeRaw = url.searchParams.get("take");
  const take = takeRaw ? Number.parseInt(takeRaw, 10) : undefined;
  const before = cursor ? decodeCursor(cursor) : null;
  if (cursor && !before) {
    return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
  }

  const page = await listChannelMessages(channelId, session.teamId, {
    take,
    before,
  });
  return NextResponse.json(page);
}

interface PostBody {
  body?: unknown;
  clientTempId?: unknown;
  mentions?: unknown;
}

const MAX_BODY_LENGTH = 4000;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const receivedAt = new Date();
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { id: channelId } = await params;

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
    return NextResponse.json(
      { error: "body too long", detail: `Max ${MAX_BODY_LENGTH} characters.` },
      { status: 413 },
    );
  }
  const clientTempId = typeof raw.clientTempId === "string" ? raw.clientTempId : undefined;

  // Tenant guard.
  const channel = await db.teamChannel.findFirst({
    where: { id: channelId, teamId: session.teamId },
    select: { id: true },
  });
  if (!channel) {
    return NextResponse.json({ error: "channel not found" }, { status: 404 });
  }

  // Parse mentions from the body — authoritative — and intersect with team
  // membership so a body crafted to ping someone in another team is a no-op.
  const parsedMentions = parseMentions(body);
  const mentionedIds = Array.from(new Set(parsedMentions.map((m) => m.userId)));
  let validMentionIds: string[] = [];
  if (mentionedIds.length > 0) {
    const teamMembers = await db.user.findMany({
      where: { teamId: session.teamId, id: { in: mentionedIds } },
      select: { id: true },
    });
    validMentionIds = teamMembers.map((u) => u.id);
  }

  // Single transaction: insert the message, fan out mention rows, bump the
  // channel's denorm fields. All-or-nothing keeps the channel list preview
  // honest with the actual message rows.
  const preview = buildMessagePreview(body, false);
  const created = await db.$transaction(async (tx) => {
    const msg = await tx.teamChannelMessage.create({
      data: {
        channelId,
        teamId: session.teamId,
        authorUserId: session.userId,
        body,
        createdAt: receivedAt,
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
    await tx.teamChannel.update({
      where: { id: channelId },
      data: { lastMessageAt: receivedAt, lastMessagePreview: preview },
    });
    return msg;
  });

  // Re-load through the standard mapper so the wire DTO is identical to
  // every other surface that emits a channel message.
  const dto = await loadMessageForEmit(created.id, session.teamId);
  if (!dto) {
    // Extremely unlikely (the row was just committed). Log + 200 since we
    // succeeded server-side; the client will hydrate on the next read.
    console.error("[team-chat] post-write reload returned null");
    return NextResponse.json({ ok: true, messageId: created.id });
  }

  emitToTeam(session.teamId, "team:channel:message", {
    teamId: session.teamId,
    channelId,
    message: dto,
    preview,
    lastMessageAt: receivedAt.toISOString(),
    ...(clientTempId ? { clientTempId } : {}),
  });

  return NextResponse.json({ ok: true, messageId: created.id, message: dto });
}
