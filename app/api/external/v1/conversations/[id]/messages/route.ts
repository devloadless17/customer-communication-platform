import "server-only";

import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { authenticateApiKey } from "@/lib/auth/external";
import { db } from "@/lib/db";
import { toExternalMessage } from "@/lib/external-shapes";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";
import { normalizeMetaSendError } from "@/lib/providers/meta";
import { emitToTeam } from "@/lib/socket/server";
import type { Message } from "@/lib/types";
import { computeWindowStatus } from "@/lib/window";

/**
 * GET  /api/external/v1/conversations/[id]/messages
 * POST /api/external/v1/conversations/[id]/messages
 *
 * GET returns the message history (newest-first, paginated by id cursor).
 * POST sends a free-form text reply — same path as the in-app reply box,
 * including the 24h-window check. Body: `{ body: string }`.
 *
 * Outside the 24h window, this returns 422 with code `outside_24h_window` so
 * n8n flows can branch to template send (deferred — see CLAUDE.md) instead
 * of silently failing.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateApiKey(req);
  if (auth instanceof NextResponse) return auth;
  const { id: conversationId } = await ctx.params;

  // Tenancy gate: confirm the conversation belongs to this team.
  const conv = await db.conversation.findFirst({
    where: { id: conversationId, teamId: auth.teamId },
    select: { id: true },
  });
  if (!conv) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));
  const cursor = url.searchParams.get("cursor");

  const rows = await db.message.findMany({
    where: { conversationId },
    orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, limit).map(toExternalMessage);
  const lastItem = items[items.length - 1];
  const nextCursor = rows.length > limit && lastItem ? lastItem.id : null;

  return NextResponse.json({ items, nextCursor });
}

interface SendBody {
  body?: unknown;
  replyToMessageId?: unknown;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateApiKey(req);
  if (auth instanceof NextResponse) return auth;
  const { id: conversationId } = await ctx.params;

  let raw: SendBody;
  try {
    raw = (await req.json()) as SendBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (!body) {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }
  if (body.length > 4096) {
    return NextResponse.json({ error: "body too long (max 4096)" }, { status: 400 });
  }

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId: auth.teamId },
    include: { contact: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  // 24h window check — Meta rejects free-form sends outside the window with
  // error 131047. We surface the same constraint before calling Meta so n8n
  // flows can branch to a template-send leg cleanly.
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
          "free-form messages are only allowed within 24h of the contact's last inbound. " +
          "use a pre-approved template for cold outbound (not yet exposed via the external API).",
        lastInboundAt: lastInbound?.timestamp.toISOString() ?? null,
      },
      { status: 422 },
    );
  }

  // Optional quoted reply, scoped to this conversation.
  let replyToMessageId: string | null = null;
  let replyToExternalId: string | undefined;
  if (typeof raw.replyToMessageId === "string" && raw.replyToMessageId) {
    const replyRow = await db.message.findFirst({
      where: {
        id: raw.replyToMessageId,
        conversationId,
        teamId: auth.teamId,
      },
      select: { id: true, externalId: true },
    });
    if (replyRow) {
      replyToMessageId = replyRow.id;
      if (!replyRow.externalId.startsWith("tmp_")) {
        replyToExternalId = replyRow.externalId;
      }
    }
  }

  let send;
  try {
    const config = await getMetaSendConfig(auth.teamId);
    send = await getMetaProvider().sendText(
      {
        to: conversation.contact.phoneNumber,
        body,
        ...(replyToExternalId ? { replyToExternalId } : {}),
      },
      config,
    );
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json(
        { error: "whatsapp_not_connected", detail: err.message },
        { status: 409 },
      );
    }
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
    console.error("[external/messages] sendText failed", err);
    return NextResponse.json(
      { error: "send_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }

  const created = await createOutboundMessageIdempotent({
    teamId: auth.teamId,
    conversationId,
    externalId: send.externalId,
    // Outbound via external API has no human author — keep senderUserId
    // null and record provenance in rawPayload for debugging.
    senderUserId: null,
    body,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: {
      sentVia: "api/external/v1",
      apiKeyId: auth.apiKeyId,
    } as Prisma.InputJsonValue,
    timestamp: send.timestamp,
    ...(replyToMessageId ? { replyToMessageId } : {}),
  });

  const preview = body.slice(0, 200);
  await db.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: send.timestamp,
      lastMessagePreview: preview,
    },
  });

  // Mirror the in-app socket emit so the inbox updates in realtime when an
  // automation replies — agents shouldn't have to refresh to see AI sends.
  const message: Message = {
    id: created.id,
    teamId: auth.teamId,
    conversationId,
    externalId: send.externalId,
    senderUserId: null,
    body,
    direction: "out",
    provider: "meta_cloud",
    status: "sent",
    rawPayload: { sentVia: "api/external/v1", apiKeyId: auth.apiKeyId },
    timestamp: send.timestamp.toISOString(),
    ...(replyToMessageId ? { replyToMessageId } : {}),
  };
  emitToTeam(auth.teamId, "message:new", {
    teamId: auth.teamId,
    conversationId,
    message,
    preview,
    lastMessageAt: send.timestamp.toISOString(),
    unreadDelta: 0,
  });

  return NextResponse.json({
    ok: true,
    message: toExternalMessage(created),
  });
}
