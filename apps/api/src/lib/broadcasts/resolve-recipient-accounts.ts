/**
 * WHICH ACCOUNT each recipient of a social campaign must be sent from.
 *
 * Resolved once, at MATERIALIZE time, and stamped onto `BroadcastRecipient`.
 *
 * ## Why here and not at send time
 *
 * The runner's rate gate (`acquireSendToken`) fires in the lane loop BEFORE the
 * recipient's conversation is read. Meta's send ceilings are per Page, so a
 * fan-out run has to bucket per account — which that gate cannot do if the
 * account is only discovered later, inside the send. Resolving it up front also
 * turns per-account campaign analytics into a plain GROUP BY instead of a join.
 *
 * ## Only the social channels
 *
 * A WhatsApp broadcast addresses a PHONE NUMBER, which any of the business's
 * numbers can message — which number sends is a business choice the composer
 * already exposes, not a constraint. So WhatsApp recipients are left NULL and the
 * campaign's own account is used, exactly as before. Stamping them would silently
 * convert a deliberate operator choice into an automatic one.
 *
 * ## A NULL result is not a failure
 *
 * A contact with no conversation yet has no account — imported and manually-added
 * contacts are exactly that. On a social channel they cannot be reached at all
 * (there is no id to address without a prior inbound), and the runner already
 * fails such a recipient individually with a clear reason. Returning NULL here
 * keeps that one code path rather than inventing a second way to fail.
 */

import { db } from "@/lib/db";
import type { Channel } from "@ccp/shared/types";
import { isAccountScopedIdentity } from "@ccp/shared/providers/capabilities";

/**
 * Map contactId → the account that issued their id on `channel`.
 *
 * Empty for WhatsApp (see the header) and for contacts with no conversation.
 * Batched in one indexed query rather than per contact: a 100k-recipient
 * materialize must not become 100k round trips.
 */
export async function resolveRecipientAccounts(
  workspaceId: string,
  channel: Channel,
  contactIds: readonly string[],
): Promise<Map<string, string>> {
  if (!isAccountScopedIdentity(channel) || contactIds.length === 0) return new Map();

  const rows = await db.conversation.findMany({
    where: {
      workspaceId,
      channel,
      contactId: { in: [...new Set(contactIds)] },
      // A thread whose account pointer was cleared (the account was removed)
      // tells us nothing — leaving it out returns NULL for that contact, which
      // routes them to the campaign's own account and fails them there with the
      // existing "not connected" reason rather than a novel one.
      channelConnectionId: { not: null },
    },
    select: { contactId: true, channelConnectionId: true },
  });

  // One conversation per contact is a schema invariant
  // (`@@unique([workspaceId, contactId])`), so there is nothing to disambiguate.
  return new Map(rows.map((r) => [r.contactId, r.channelConnectionId!]));
}
