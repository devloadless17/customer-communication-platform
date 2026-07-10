import { db } from "@/lib/db";
import {
  CHANNEL_CAPABILITIES,
  isChannelLive,
} from "@ccp/shared/providers/capabilities";
import { computeWindowStatus, effectiveSendWindowMs } from "@ccp/shared/utils/window";
import type { Channel } from "@ccp/shared/types";

/**
 * Omnichannel targeting (P4 / §6). A `Customer` (person) owns many channel-scoped
 * contacts; when a send targets the PERSON (a broadcast or a workflow action), we
 * must pick the single best channel to reach them on — not blast every contact.
 *
 * "Best" = a live, reachable contact, ranked:
 *   1. currently INSIDE its free-form send window (so a plain message lands), then
 *   2. most recently active (freshest lastInboundAt).
 *
 * The caller decides whether an out-of-window pick is acceptable for its send
 * type (a template can reopen WhatsApp; a free-form social send can't). Returns
 * null when the customer has no live, reachable contact at all.
 */
export interface BestChannelResult {
  contactId: string;
  channel: Channel;
  /** Destination address — phone (phone channels) or PSID/IGSID (social). */
  to: string;
  /** True when a plain free-form message can be sent right now. */
  inWindow: boolean;
}

/** The contact shape `pickBestChannel` ranks over — a subset of `Contact`. */
export interface RankableContact {
  id: string;
  identityChannel: Channel;
  phoneNumber: string | null;
  externalContactId: string | null;
  lastInboundAt: Date | null;
}

/**
 * Pure ranking — pick a person's best reachable channel from ALREADY-LOADED
 * contact rows. Extracted so a bulk caller (broadcast customer-mode) can fetch
 * every person's siblings in ONE query and rank in memory, instead of one
 * `findMany` per person. `bestChannelForCustomer` is the single-person wrapper.
 */
export function pickBestChannel(
  contacts: RankableContact[],
  now: number,
  allowedChannels?: ReadonlySet<Channel>,
): BestChannelResult | null {
  const candidates = contacts
    .map((c) => {
      // Only channels with a live provider are reachable at all.
      if (!isChannelLive(c.identityChannel)) return null;
      // …and, when the caller constrains it, only team-connected channels.
      if (allowedChannels && !allowedChannels.has(c.identityChannel)) return null;
      const to = c.phoneNumber ?? c.externalContactId;
      if (!to) return null;
      const windowMs = effectiveSendWindowMs(CHANNEL_CAPABILITIES[c.identityChannel]);
      // `null` window (no restriction) is always sendable; else check the state.
      const state =
        windowMs === null
          ? "open"
          : computeWindowStatus(c.lastInboundAt?.toISOString() ?? null, now, windowMs).state;
      return {
        contactId: c.id,
        channel: c.identityChannel,
        to,
        inWindow: state === "open" || state === "closing-soon",
        lastInboundMs: c.lastInboundAt?.getTime() ?? 0,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  if (candidates.length === 0) return null;

  // In-window first, then most-recently-active.
  candidates.sort(
    (a, b) => Number(b.inWindow) - Number(a.inWindow) || b.lastInboundMs - a.lastInboundMs,
  );
  const best = candidates[0]!;
  return { contactId: best.contactId, channel: best.channel, to: best.to, inWindow: best.inWindow };
}

export async function bestChannelForCustomer(
  teamId: string,
  customerId: string,
  now: number = Date.now(),
  /**
   * When provided, restrict candidates to channels the caller knows the team
   * can actually SEND on right now (a connected `ChannelConnection` with valid
   * creds). Without it, `isChannelLive` only proves a provider is *registered*,
   * so a person could be ranked onto a channel the team never connected (or
   * whose token expired) and then be dropped at send instead of reaching them
   * on a connected channel. Omit for callers that don't care (they get the
   * previous behavior).
   */
  allowedChannels?: ReadonlySet<Channel>,
): Promise<BestChannelResult | null> {
  const contacts = await db.contact.findMany({
    where: { teamId, customerId, deletedAt: null },
    select: {
      id: true,
      identityChannel: true,
      phoneNumber: true,
      externalContactId: true,
      lastInboundAt: true,
    },
  });

  return pickBestChannel(contacts, now, allowedChannels);
}
