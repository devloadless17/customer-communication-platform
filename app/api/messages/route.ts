import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { trackOnOutboundMessage } from "@/lib/conversations/analytics";
import { db } from "@/lib/db";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import { loadReplySnapshotById } from "@/lib/providers/ingest";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import { emitToTeam } from "@/lib/socket/server";
import type { Message } from "@/lib/types";
import { computeWindowStatus } from "@/lib/window";

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
  // target row, the provider config, and the last-inbound timestamp (for the
  // 24h window check) are all independent; running them sequentially was
  // costing ~3x round-trip-time for no reason.
  const [conversation, replyToRow, config, lastInbound] = await Promise.all([
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
    // Pre-fetch the latest inbound so we can short-circuit on a closed 24h
    // window WITHOUT a Meta round-trip. Meta would reject with 131047 anyway,
    // but the round-trip is ~300ms wasted and the agent gets a clearer error
    // sourced from our own UX copy rather than Meta's raw body.
    db.message.findFirst({
      where: { conversationId, direction: "in" },
      orderBy: { timestamp: "desc" },
      select: { timestamp: true },
    }),
  ]);

  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }
  if (config instanceof ProviderNotConfiguredError) {
    return NextResponse.json(
      { error: "whatsapp_not_connected", detail: config.message },
      { status: 409 },
    );
  }

  // 24h window pre-check. Free-form text only works inside the window —
  // outside, the agent must send an approved template via /api/messages/
  // template. We surface the same `outside_24h_window` code the external API
  // returns so the UI can branch on a stable string.
  const win = computeWindowStatus(lastInbound?.timestamp.toISOString() ?? null);
  if (win.state === "closed" || win.state === "never") {
    return NextResponse.json(
      {
        error: "outside_24h_window",
        detail:
          "24-hour window closed — send an approved template to re-engage this contact.",
        lastInboundAt: lastInbound?.timestamp.toISOString() ?? null,
      },
      { status: 422 },
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

  if (!conversation.contact.phoneNumber) {
    // Reachable only on non-phone-channel contacts (future Instagram/Telegram).
    // WhatsApp send needs a number; non-phone channels will have their own
    // send routes per the multi-channel provider work.
    return NextResponse.json(
      { error: "contact_has_no_phone", detail: "This contact has no WhatsApp number." },
      { status: 400 },
    );
  }
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
    const normalized = normalizeMetaSendError(err);
    if (normalized) {
      // Stable error code surface — the UI / external consumers can branch
      // on `error` ("outside_24h_window", "rate_limited", etc.) instead of
      // substring-matching Meta's raw body.
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
    console.error("[api/messages] sendText failed", err);
    return NextResponse.json(
      { error: "send_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  // ── Phase C — DB write + snapshot finalize, in parallel. message.create
  // gets us the id we need for the emit; the snapshot lookup is already
  // mostly done from its head start above.
  const [created, replySnapshot] = await Promise.all([
    createOutboundMessageIdempotent({
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

  // Analytics: count this outbound + stamp firstResponseAt if it's the first
  // outbound after an inbound. Fire-and-forget — failure here doesn't ghost
  // the message the agent just sent.
  void trackOnOutboundMessage({ conversationId, teamId, senderUserId: userId });

  return NextResponse.json({ ok: true, messageId: created.id });
}
