import { db } from "@/lib/db";
import type { Channel } from "@ccp/shared/types";

/**
 * Token-health flag for a channel connection. When a send fails with Graph error
 * 190 (access token expired/revoked), we mark the channel so Settings can show a
 * "reconnect" banner and admins are prompted to re-issue the token — Meta's
 * access-token best practice (a dead token is otherwise invisible until an agent
 * hits a failed reply, since inbound webhooks need no token). Best-effort: a
 * failure to record this must never mask or block the send-failure path.
 */
export async function flagChannelNeedsReconnect(
  workspaceId: string,
  channel: Channel,
  /**
   * The CONNECTION whose token actually failed. A workspace can hold several
   * accounts on one channel with independent tokens, so flagging the whole
   * channel marked every sibling number/Page as needing reconnect over one
   * dead credential. Omitted (callers that genuinely can't name the account)
   * keeps the channel-wide legacy write — correct for single-account.
   */
  channelConnectionId?: string | null,
): Promise<void> {
  await db.channelConnection
    .updateMany({
      where: {
        workspaceId,
        channel,
        ...(channelConnectionId ? { id: channelConnectionId } : {}),
      },
      data: { needsReconnect: true, lastAuthErrorAt: new Date() },
    })
    .catch(() => undefined);
}

/**
 * Clear the reconnect flag — self-heal. Called on any SUCCESSFUL send, so a
 * channel whose token was re-issued (by any path, including WhatsApp's) recovers
 * automatically the moment it can send again. The `needsReconnect: true`
 * predicate makes this a no-op query when the flag isn't set, so it's free on the
 * common (healthy) send path. The connect flows clear it directly too, for an
 * instant banner dismiss on reconnect.
 *
 * Pass `channelConnectionId` whenever the caller already knows which account
 * succeeded — then the clear is exact. It is OPTIONAL because the hot success
 * path does not know: naming the account there costs an extra conversation read
 * on every send, which is not worth paying to keep a badge honest.
 *
 * When omitted this stays CHANNEL-WIDE, and the tradeoff is real rather than
 * free: account A's successful send clears account B's badge too. The comment
 * here used to claim that "self-corrects on the next send" — it does NOT for an
 * IDLE sibling, which can carry a genuinely dead credential and show no warning
 * until someone tries to use it. Still the safer direction of the asymmetry: a
 * wrongly CLEARED flag re-appears the moment that number is used, while a
 * wrongly SET one (the old channel-wide FLAG) told an admin to reconnect
 * numbers that were fine.
 */
export async function clearChannelNeedsReconnect(
  workspaceId: string,
  channel: Channel,
  channelConnectionId?: string | null,
): Promise<void> {
  await db.channelConnection
    .updateMany({
      where: {
        workspaceId,
        channel,
        needsReconnect: true,
        ...(channelConnectionId ? { id: channelConnectionId } : {}),
      },
      data: { needsReconnect: false, lastAuthErrorAt: null },
    })
    .catch(() => undefined);
}
