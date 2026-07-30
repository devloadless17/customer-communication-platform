"use client";

import { createContext, useContext, useMemo } from "react";

import type { ChannelAccountDirectoryEntry } from "@/lib/api/queries";
import type { Channel } from "@ccp/shared/types";
import { accountVisibility } from "@/features/channels/lib/account-visibility";

/**
 * Which of the workspace's channel accounts a conversation belongs to.
 *
 * A workspace can connect several WhatsApp numbers, Facebook Pages or Instagram
 * handles. `Conversation.channelConnectionId` records which one each thread is
 * on — and it is re-stamped on every inbound, so it always names the account the
 * reply will go out on. Until now the inbox never showed it, which meant an
 * agent in a two-number workspace replied without knowing whether the customer
 * was talking to Sales or Support.
 *
 * The directory is SSR-seeded once in the APP layout and never refetched: it is
 * a handful of rows that change only when an admin connects or disconnects an
 * account, and the alternative — joining the account onto every conversation
 * row — would widen the hottest read in the app for a string that repeats.
 * (A rename / set-default / remove publishes `team.catalog_changed`, which
 * re-runs the layout, so it does not go stale either.)
 *
 * Mounted at the APP layout, not the inbox one, for a structural reason: the
 * call layer (`CallProvider`) lives above the inbox, so an inbox-scoped
 * provider is invisible to the incoming-call toast and the live-call panel —
 * the two surfaces where knowing which business identity is being called
 * matters most. Contacts, calls, templates and broadcasts previously each
 * refetched the same rows for the same reason.
 *
 * `showAccountFor(channel)` is the important part of the contract: attribution
 * shows from the FIRST connected account, not the second. The chip is not only a
 * disambiguator — it is how an agent learns that accounts exist at all, and
 * introducing it at the moment a second number appears is introducing it at the
 * moment it is hardest to learn. It stays hidden only when a channel has NO
 * accounts, where there is nothing to name.
 */
interface ChannelAccountsValue {
  byId: Map<string, ChannelAccountDirectoryEntry>;
  /** Every account, in the server's order (default first, then oldest). */
  all: ChannelAccountDirectoryEntry[];
  /**
   * NAME the account: true when `channel` has at least one connected account.
   * For attribution — "which of my numbers is this".
   */
  showAccountFor: (channel: Channel | undefined) => boolean;
  /**
   * Offer a CHOICE between accounts: true only when `channel` has more than one.
   *
   * Distinct from `showAccountFor` on purpose. Naming the single number an agent
   * works on is informative; offering a one-entry "pick an account" filter is
   * clutter. These were one predicate, so relaxing attribution to show from the
   * first account would also have grown a pointless one-item filter in the inbox
   * sidebar — two different questions that only coincidentally had the same answer.
   */
  hasMultipleFor: (channel: Channel | undefined) => boolean;
  /** The account for a conversation, or null when unknown/not worth showing. */
  accountFor: (
    channel: Channel | undefined,
    channelConnectionId: string | null | undefined,
  ) => ChannelAccountDirectoryEntry | null;
  /**
   * The directory FETCH failed, as opposed to the workspace genuinely having no
   * accounts. Both arrive as an empty list, and a surface that lets an operator
   * pick a sending account must not present "we couldn't load your numbers" as
   * "you have one number" — the broadcast composer says so out loud.
   */
  failed: boolean;
}

const EMPTY: ChannelAccountsValue = {
  byId: new Map(),
  all: [],
  showAccountFor: () => false,
  hasMultipleFor: () => false,
  accountFor: () => null,
  failed: false,
};

const ChannelAccountsContext = createContext<ChannelAccountsValue>(EMPTY);


export function ChannelAccountsProvider({
  accounts,
  failed = false,
  children,
}: {
  accounts: ChannelAccountDirectoryEntry[];
  /** True when the directory read FAILED — see `failed` on the context value. */
  failed?: boolean;
  children: React.ReactNode;
}) {
  const value = useMemo<ChannelAccountsValue>(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const { showAccountFor, hasMultipleFor } = accountVisibility(accounts);
    return {
      byId,
      all: accounts,
      showAccountFor,
      hasMultipleFor,
      accountFor: (channel, channelConnectionId) => {
        if (!channelConnectionId || !showAccountFor(channel)) return null;
        return byId.get(channelConnectionId) ?? null;
      },
      failed,
    };
  }, [accounts, failed]);

  return (
    <ChannelAccountsContext.Provider value={value}>{children}</ChannelAccountsContext.Provider>
  );
}

/**
 * Safe outside the provider — returns the empty directory, so a component that
 * renders in both the inbox and (say) the contacts page never has to guard.
 */
export function useChannelAccounts(): ChannelAccountsValue {
  return useContext(ChannelAccountsContext);
}
