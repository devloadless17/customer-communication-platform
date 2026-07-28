import { ConflictException } from "@nestjs/common";

import { db } from "@/lib/db";
import type { Channel } from "@ccp/shared/types";

/**
 * Refuse a CHANNEL-level disconnect that would silently take out several
 * accounts.
 *
 * `DELETE /api/workspace/{whatsapp,messenger,instagram}` deletes EVERY
 * `ChannelConnection` on the channel, not one. Both account pointers are
 * `onDelete: SetNull`, so it strands every thread on the channel (the next
 * reply fails `account-unresolved`) and nulls the sender of every scheduled
 * campaign. The per-account `remove()` has had a `removalImpact` preflight
 * since multi-account shipped; this route is strictly more destructive and had
 * none — and on Messenger/Instagram the UI copy didn't even say "all".
 *
 * Same posture as `loadSendCipher`'s ACCOUNT_UNRESOLVED: when the blast radius
 * is ambiguous, refuse and make the caller say what it means. One account is
 * unambiguous and passes untouched, so single-account workspaces — every
 * workspace before this feature — see no change at all.
 */
export async function assertChannelDisconnectConfirmed(
  workspaceId: string,
  channel: Channel,
  confirmAll: boolean | undefined,
): Promise<void> {
  if (confirmAll) return;
  const accounts = await db.channelConnection.count({ where: { workspaceId, channel } });
  if (accounts <= 1) return;
  throw new ConflictException({
    error: "multiple_accounts_confirm_required",
    detail:
      `This workspace has ${accounts} accounts connected on this channel, and ` +
      `disconnecting removes ALL of them. Remove a single account from its row in ` +
      `the connected-accounts list, or re-send with confirmAll to remove every one.`,
    accounts,
  });
}
