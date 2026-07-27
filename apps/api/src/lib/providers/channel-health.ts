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
 * Deliberately CHANNEL-WIDE (no per-connection narrowing, unlike the flag):
 * the hot success path would need an extra conversation read to name its
 * account, and clearing a sibling too broadly self-corrects — its very next
 * send re-flags it. The asymmetry is safe in exactly one direction: a wrongly
 * CLEARED flag re-appears on the next failure; a wrongly SET one (the old
 * channel-wide flag) told an admin to reconnect numbers that were fine.
 */
export async function clearChannelNeedsReconnect(
  workspaceId: string,
  channel: Channel,
): Promise<void> {
  await db.channelConnection
    .updateMany({
      where: { workspaceId, channel, needsReconnect: true },
      data: { needsReconnect: false, lastAuthErrorAt: null },
    })
    .catch(() => undefined);
}
