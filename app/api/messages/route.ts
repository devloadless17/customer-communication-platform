import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import { loadReplySnapshotById } from "@/lib/providers/ingest";
import { MetaSendError } from "@/lib/providers/meta";
import { emitToTeam } from "@/lib/socket/server";
import type { Message } from "@/lib/types";

/**
 * Outbound message endpoint.
 *
 * Body: `{ conversationId, body }`. Looks up the conversation, calls
 * Meta's sendText, persists the row, and emits `message:new`.
 *
 * Provider failures bubble up as 4xx so the agent sees the real error
 * (24h-window, template required, etc.) — silently swallowing them would
 * be the worst possible UX.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  conversationId?: unknown;
  body?: unknown;
  clientTempId?: unknown;
  replyToMessageId?: unknown;
}

export async function POST(req: Request) {
  // Stamp the message's logical send time at request arrival, not at the
  // moment Meta's API returns. Meta's response time varies wildly between
  // text and media sends; if a media call happens to complete faster than a
  // text call the user just fired, the row order on the server (and on every
  // client after reload) ends up reversed. Receive-time stamping reflects
  // the user's actual send sequence.
  const receivedAt = new Date();
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { userId, teamId } = session;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const conversationId = typeof raw.conversationId === "string" ? raw.conversationId : null;
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  const clientTempId = typeof raw.clientTempId === "string" ? raw.clientTempId : undefined;
  const replyToMessageIdRaw =
    typeof raw.replyToMessageId === "string" && raw.replyToMessageId
      ? raw.replyToMessageId
      : null;
  if (!conversationId || !body) {
    return NextResponse.json({ error: "conversationId and body required" }, { status: 400 });
  }

  // ── Phase A — parallel pre-flight reads. The conversation row, the reply
  // target row, and the provider config are independent; running them
  // sequentially was costing ~2x round-trip-time for no reason. The
  // findFirst on conversation now `select`s only what Meta needs (just the
  // contact phone) instead of pulling the full contact row.
  const [conversation, replyToRow, config] = await Promise.all([
    db.conversation.findFirst({
      where: { id: conversationId, teamId },
      select: { id: true, contact: { select: { phoneNumber: true } } },
    }),
    replyToMessageIdRaw
      ? db.message.findFirst({
          where: { id: replyToMessageIdRaw, conversationId, teamId },
          select: { id: true, externalId: true },
        })
      : Promise.resolve(null),
    getMetaSendConfig(teamId).catch(
      (err: unknown) => {
        if (err instanceof ProviderNotConfiguredError) return err;
        throw err;
      },
    ),
  ]);

  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }
  if (config instanceof ProviderNotConfiguredError) {
    return NextResponse.json(
      { error: "whatsapp not connected", detail: config.message },
      { status: 409 },
    );
  }

  // Resolve the reply target. confirm it lives in this conversation (so an
  // attacker can't quote across teams). A pending optimistic id won't be in
  // DB — `replyToRow` is null and we simply don't quote.
  let replyToMessageId: string | null = null;
  let replyToExternalId: string | undefined;
  if (replyToRow) {
    replyToMessageId = replyToRow.id;
    // Skip the wamid for any externalId we generated (legacy/dev seeds);
    // Meta would 4xx on an unknown id.
    if (!replyToRow.externalId.startsWith("tmp_")) {
      replyToExternalId = replyToRow.externalId;
    }
  }

  // ── Phase B — Meta send. This is the irreducible 200–800ms HTTP hop and
  // dominates the entire request. While it's in flight we kick off the
  // reply-snapshot prefetch in parallel so it's effectively free.
  const replySnapshotPromise = replyToMessageId
    ? loadReplySnapshotById(replyToMessageId)
    : Promise.resolve(null);

  let send;
  try {
    send = await getMetaProvider().sendText(
      {
        to: conversation.contact.phoneNumber,
        body,
        ...(replyToExternalId ? { replyToExternalId } : {}),
      },
      config,
    );
  } catch (err) {
    if (err instanceof MetaSendError) {
      // Pass Meta's error code/body through verbatim — the agent needs it.
      return NextResponse.json(
        { error: "provider rejected send", status: err.httpStatus, detail: err.body },
        { status: 422 },
      );
    }
    console.error("[api/messages] sendText failed", err);
    return NextResponse.json(
      { error: "send failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // ── Phase C — DB write + snapshot finalize, in parallel. message.create
  // gets us the id we need for the emit; the snapshot lookup is already
  // mostly done from its head start above.
  const [created, replySnapshot] = await Promise.all([
    db.message.create({
      data: {
        teamId,
        conversationId,
        externalId: send.externalId,
        senderUserId: userId,
        body,
        direction: "out",
        provider: "meta_cloud",
        status: "sent",
        rawPayload: { sentVia: "api/messages" } as Prisma.InputJsonValue,
        timestamp: receivedAt,
        ...(replyToMessageId ? { replyToMessageId } : {}),
      },
    }),
    replySnapshotPromise,
  ]);

  const preview = body.slice(0, 200);
  const message: Message = {
    id: created.id,
    teamId,
    conversationId,
    externalId: send.externalId,
    senderUserId: userId,
    body,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: { sentVia: "api/messages" },
    timestamp: receivedAt.toISOString(),
    ...(replyToMessageId
      ? { replyToMessageId, replyTo: replySnapshot ?? null }
      : {}),
  };

  // ── Phase D — emit the socket event NOW. This is what unfreezes the
  // sender's optimistic bubble and lights up every other open client. Every
  // millisecond we shave off the path between here and Meta's response is
  // shaved off the "clock → check" transition the sender perceives.
  emitToTeam(teamId, "message:new", {
    teamId,
    conversationId,
    message,
    preview,
    lastMessageAt: send.timestamp.toISOString(),
    unreadDelta: 0,
    ...(clientTempId ? { clientTempId } : {}),
  });

  // ── Phase E — deferred: bump the conversation's lastMessageAt/preview
  // for the next cold load. Live clients already have it from the socket
  // event above, so this is just hydration cache and must not block the
  // response. A long-lived custom Node server (not serverless) means
  // fire-and-forget is safe here.
  void db.conversation
    .update({
      where: { id: conversationId },
      data: {
        lastMessageAt: send.timestamp,
        lastMessagePreview: preview,
      },
    })
    .catch((err) =>
      console.error("[api/messages] deferred conversation.update failed", err),
    );

  return NextResponse.json({ ok: true, messageId: created.id });
}
