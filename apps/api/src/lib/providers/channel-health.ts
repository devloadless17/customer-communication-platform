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
  teamId: string,
  channel: Channel,
): Promise<void> {
  await db.channelConnection
    .updateMany({
      where: { teamId, channel },
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
 */
export async function clearChannelNeedsReconnect(
  teamId: string,
  channel: Channel,
): Promise<void> {
  await db.channelConnection
    .updateMany({
      where: { teamId, channel, needsReconnect: true },
      data: { needsReconnect: false, lastAuthErrorAt: null },
    })
    .catch(() => undefined);
}
