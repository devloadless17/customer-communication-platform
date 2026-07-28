import type { PrismaClient } from "@prisma/client";

import type { Channel } from "@ccp/shared/types";

/**
 * THE rule for binding an OUTBOUND-FIRST conversation to a channel account.
 *
 * A thread created by an inbound gets its account from the webhook — ingest
 * stamps it and re-stamps it whenever the customer reaches a different one of
 * our numbers. A thread the BUSINESS opens first (compose-new, forward, a
 * broadcast to someone who never wrote in, a workflow send, a `/v1` start) has
 * no webhook to learn it from, so it has to be resolved here.
 *
 * Leaving `channelConnectionId` null is not a neutral default. It means:
 *   - the thread is unattributed in the inbox and invisible to the per-account
 *     filter;
 *   - it silently migrates to whichever account becomes the default later;
 *   - every send from it resolves the workspace DEFAULT account, so the reply
 *     can go out from a number the customer never contacted — where no 24h
 *     service window exists;
 *   - and once a workspace has two active accounts on the channel, the
 *     `account-unresolved` guard refuses the send outright, so the thread is
 *     simply unusable until the customer happens to message in.
 *
 * `startConversation` worked this out and got it right; four other create paths
 * did not, which is why this is a shared function rather than a fifth copy.
 *
 * An explicit id is validated against THIS workspace AND channel, so a caller
 * can never bind a thread to another tenant's number or to an account
 * belonging to a different channel.
 *
 * Returns null only when the channel genuinely has no active account. That is
 * deliberate: the create still succeeds and the first send fails with the
 * actionable "not connected" error it always did, rather than the create
 * throwing and losing the contact with it.
 */
export async function resolveOutboundAccountId(
  db: Pick<PrismaClient, "channelConnection">,
  workspaceId: string,
  channel: Channel,
  explicitId?: string | null,
): Promise<{ accountId: string | null; explicitNotFound: boolean }> {
  if (explicitId) {
    const named = await db.channelConnection.findFirst({
      where: { id: explicitId, workspaceId, channel, isActive: true },
      select: { id: true },
    });
    return { accountId: named?.id ?? null, explicitNotFound: !named };
  }
  const fallback = await db.channelConnection.findFirst({
    where: { workspaceId, channel, isDefault: true, isActive: true },
    select: { id: true },
  });
  return { accountId: fallback?.id ?? null, explicitNotFound: false };
}
