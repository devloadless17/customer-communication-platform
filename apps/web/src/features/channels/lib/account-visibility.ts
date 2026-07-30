import type { ChannelAccountDirectoryEntry } from "@/lib/api/queries";
import type { Channel } from "@ccp/shared/types";

/**
 * When does a surface NAME a channel account, and when does it offer a CHOICE
 * between accounts?
 *
 * Two predicates that differ by one character and answer different questions:
 *
 *   showAccountFor  >= 1   attribution — "which of my numbers is this thread on"
 *   hasMultipleFor  >  1   a filter — "narrow the inbox to one account"
 *
 * Attribution originally required a SECOND account, on the theory that it is purely
 * a disambiguator. That made the account concept first appear on the day a workspace
 * connected a second number — the moment it became load-bearing, and so the worst
 * possible moment for an agent to be working out what the chip means. It now shows
 * from the first account: one quiet label, and nothing changes conceptually when the
 * workspace grows.
 *
 * The filter deliberately did NOT move with it. These were ONE predicate, so
 * relaxing attribution also grew a pointless one-entry "pick an account" list in the
 * inbox sidebar. Two questions that only coincidentally had the same answer.
 *
 * A plain `.ts` module (not the context `.tsx`) so the rule is importable by the
 * pure-function test harness, which does not parse JSX.
 */
export function accountVisibility(accounts: ChannelAccountDirectoryEntry[]): {
  showAccountFor: (channel: Channel | undefined) => boolean;
  hasMultipleFor: (channel: Channel | undefined) => boolean;
} {
  const perChannel = new Map<string, number>();
  for (const a of accounts) {
    perChannel.set(a.channel, (perChannel.get(a.channel) ?? 0) + 1);
  }
  return {
    // Zero accounts stays false: there is nothing to name, and `accountFor` must
    // keep returning null so no surface renders an empty chip. (A FAILED directory
    // read also arrives as zero — see `failed` on the context value.)
    showAccountFor: (channel) => (channel ? (perChannel.get(channel) ?? 0) >= 1 : false),
    hasMultipleFor: (channel) => (channel ? (perChannel.get(channel) ?? 0) > 1 : false),
  };
}
