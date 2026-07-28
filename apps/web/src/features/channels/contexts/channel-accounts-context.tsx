"use client";

import { createContext, useContext, useMemo } from "react";

import type { ChannelAccountDirectoryEntry } from "@/lib/api/queries";
import type { Channel } from "@ccp/shared/types";

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
 * The directory is SSR-seeded once in the inbox layout and never refetched: it
 * is a handful of rows that change only when an admin connects or disconnects
 * an account, and the alternative — joining the account onto every conversation
 * row — would widen the hottest read in the app for a string that repeats.
 *
 * `showAccountFor(channel)` is the important part of the contract. A workspace
 * with ONE WhatsApp number must look exactly as it does today: attribution is a
 * disambiguator, and rendering "+1 555 010 0000" on every row when there is
 * nothing to disambiguate is noise. So the chip appears only once a channel
 * actually holds more than one account.
 */
interface ChannelAccountsValue {
  byId: Map<string, ChannelAccountDirectoryEntry>;
  /** True when `channel` has more than one connected account. */
  showAccountFor: (channel: Channel | undefined) => boolean;
  /** The account for a conversation, or null when unknown/not worth showing. */
  accountFor: (
    channel: Channel | undefined,
    channelConnectionId: string | null | undefined,
  ) => ChannelAccountDirectoryEntry | null;
}

const EMPTY: ChannelAccountsValue = {
  byId: new Map(),
  showAccountFor: () => false,
  accountFor: () => null,
};

const ChannelAccountsContext = createContext<ChannelAccountsValue>(EMPTY);

export function ChannelAccountsProvider({
  accounts,
  children,
}: {
  accounts: ChannelAccountDirectoryEntry[];
  children: React.ReactNode;
}) {
  const value = useMemo<ChannelAccountsValue>(() => {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const perChannel = new Map<string, number>();
    for (const a of accounts) {
      perChannel.set(a.channel, (perChannel.get(a.channel) ?? 0) + 1);
    }
    const showAccountFor = (channel: Channel | undefined) =>
      channel ? (perChannel.get(channel) ?? 0) > 1 : false;
    return {
      byId,
      showAccountFor,
      accountFor: (channel, channelConnectionId) => {
        if (!channelConnectionId || !showAccountFor(channel)) return null;
        return byId.get(channelConnectionId) ?? null;
      },
    };
  }, [accounts]);

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
