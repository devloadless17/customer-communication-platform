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
 * Pass `channelConnectionId` whenever the caller resolved which account sent —
 * then the clear is exact. Every send path already resolves it (the thread's
 * `channelConnectionId` is read to pick the send config, §2 "a reply goes out
 * the account the customer messaged"), so as of 2026-08-13 all success-path
 * callers pass it: `sendTextInternal`, `sendTemplateInternal` and the queue
 * worker's `executeTextSendJob`. The old "the hot path does not know" claim
 * was stale — naming the account costs nothing.
 *
 * When omitted (an unbound thread's `null`) this stays CHANNEL-WIDE, which is
 * exact anyway: the account-less send fallback only exists while the workspace
 * has ≤1 active account on the channel (see `loadSendCipher`). If a caller
 * ever clears channel-wide with several accounts live, the tradeoff is real:
 * account A's success clears account B's badge, and an IDLE sibling with a
 * genuinely dead credential shows no warning until someone uses it.
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

/**
 * Record an inbound webhook REJECTED at our door (403: bad_signature /
 * no_config). Meta retries with backoff and gives up on an endpoint after
 * ~24-36h of failures, so a persistent mismatch is silently-lost inbound —
 * this stamp is what lets Settings say it out loud.
 *
 * Channel-WIDE on purpose: a failed signature cannot be attributed to an
 * account (the body was never trusted enough to parse). Throttled in-process
 * (≥60s between writes per workspace+channel) so a Meta retry storm costs one
 * UPDATE a minute, and fire-and-forget like the flag/clear above — recording
 * the rejection must never affect the 403 response itself.
 *
 * Deliberately NOT recorded for `no_signature`: Meta always signs, so a
 * signature-less POST is an internet scanner, not a Meta misconfiguration.
 * Residual honesty: `bad_signature` IS still reachable by a stranger who
 * learns the webhook URL and sends a garbage signature header — that cannot
 * be distinguished from a genuinely mis-stored App secret without verifying
 * the sender is Meta, which is exactly what the signature was for. The
 * banner therefore reads as "check the secret", never as an alarm, and the
 * 24h staleness filter retires a one-off spoof by itself.
 */
const webhookRejectWriteAt = new Map<string, number>();
const WEBHOOK_REJECT_THROTTLE_MS = 60_000;

export function recordWebhookRejected(
  workspaceId: string,
  channel: Channel,
  reason: "bad_signature" | "no_config",
): void {
  const key = `${workspaceId}:${channel}`;
  const now = Date.now();
  const last = webhookRejectWriteAt.get(key) ?? 0;
  if (now - last < WEBHOOK_REJECT_THROTTLE_MS) return;
  webhookRejectWriteAt.set(key, now);
  // Bounded: one entry per (workspace, channel) pair that ever rejected —
  // a few dozen keys at this deployment's scale, pruning would be ceremony.
  void db.channelConnection
    .updateMany({
      where: { workspaceId, channel },
      data: { lastWebhookRejectedAt: new Date(), lastWebhookRejectReason: reason },
    })
    .catch(() => undefined);
}

/**
 * The settings-surface view of the stamp above, with the 24h staleness filter
 * applied server-side in ONE place for all three channel config reads — Meta
 * stops retrying a failing endpoint after ~24-36h, so an older stamp is
 * history, not an active problem, and rendering it would cry wolf forever.
 */
export function recentWebhookRejection(
  at: Date | null,
  reason: string | null,
): { at: string; reason: string } | null {
  if (!at || !reason) return null;
  if (Date.now() - at.getTime() > 24 * 60 * 60_000) return null;
  return { at: at.toISOString(), reason };
}
