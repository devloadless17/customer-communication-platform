import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, ProviderNotConfiguredError } from "@/lib/providers/config";

/**
 * Tell the customer's WhatsApp to show a "typing…" bubble. Meta's API
 * piggybacks the indicator on the read-receipt endpoint: marks the latest
 * inbound as read AND shows the customer a typing bubble for up to 25s,
 * auto-dismissing when our next outbound lands or the timer expires.
 *
 * Client throttles this to once every ~20s while the agent keeps typing.
 * No "stop typing" endpoint exists on Meta's side.
 *
 * Silent no-op when there's no inbound to anchor on (a brand-new contact
 * the agent is about to send a template to has no read-anchor message).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;
  const { id: conversationId } = await ctx.params;

  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, teamId },
    select: { id: true },
  });
  if (!conversation) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  const latestInbound = await db.message.findFirst({
    where: { conversationId, direction: "in" },
    orderBy: { timestamp: "desc" },
    select: { externalId: true, provider: true },
  });

  if (!latestInbound || latestInbound.provider !== "meta_cloud") {
    return NextResponse.json({ ok: true, skipped: "no-inbound" });
  }

  try {
    const config = await getMetaSendConfig(teamId);
    await getMetaProvider().sendTypingIndicator?.(latestInbound.externalId, config);
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ ok: true, skipped: "provider-not-configured" });
    }
    console.warn("[api/conversations/typing] send failed", err);
  }

  return NextResponse.json({ ok: true });
}
