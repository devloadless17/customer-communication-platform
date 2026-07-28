import { apiFetch } from "@/lib/api/client-fetch";

export interface ChannelRemovalImpact {
  accounts: number;
  conversations: number;
  openConversations: number;
  scheduledBroadcasts: number;
}

/**
 * What the CHANNEL-level disconnect would destroy.
 *
 * Best-effort: a failed read must not block the disconnect, it just falls back
 * to the vague copy. Returns null when the count is unavailable.
 */
export async function fetchChannelRemovalImpact(
  channel: string,
): Promise<ChannelRemovalImpact | null> {
  try {
    const res = await apiFetch(
      `/api/workspace/channels/${encodeURIComponent(channel)}/accounts/removal-impact`,
    );
    if (!res.ok) return null;
    return (await res.json()) as ChannelRemovalImpact;
  } catch {
    return null;
  }
}

/**
 * Confirm-dialog copy for disconnecting a whole channel.
 *
 * The button removes EVERY account on the channel, and both account pointers
 * are `onDelete: SetNull` — so it strands every thread (the next reply fails
 * "account-unresolved") and nulls the sender of every scheduled campaign.
 * Messenger and Instagram used to say only "no new messages will flow", which
 * on a two-Page workspace understated it by an entire Page.
 *
 * Single-account workspaces keep the short, non-alarming copy — that is the
 * overwhelmingly common case and it genuinely is just one account.
 */
export function channelDisconnectCopy(
  noun: string,
  nounPlural: string,
  impact: ChannelRemovalImpact | null,
): { description: string; confirmLabel: string } {
  const many = (impact?.accounts ?? 0) > 1;
  if (!many) {
    return {
      description: `Your conversations will stay, but no new messages will flow until you reconnect.`,
      confirmLabel: "Disconnect",
    };
  }
  const parts = [
    `This disconnects ALL ${impact!.accounts} ${nounPlural} in this workspace, not just one.`,
  ];
  if (impact!.openConversations > 0) {
    parts.push(
      `${impact!.openConversations} open conversation${impact!.openConversations === 1 ? "" : "s"} ` +
        `will be left unable to reply until the ${noun} is reconnected.`,
    );
  }
  if (impact!.scheduledBroadcasts > 0) {
    parts.push(
      `${impact!.scheduledBroadcasts} scheduled or running broadcast${impact!.scheduledBroadcasts === 1 ? "" : "s"} ` +
        `will lose ${impact!.scheduledBroadcasts === 1 ? "its" : "their"} sending ${noun}.`,
    );
  }
  parts.push(
    `Your conversations stay. To remove a single ${noun}, use its row in the connected-${nounPlural} list instead.`,
  );
  return { description: parts.join(" "), confirmLabel: `Disconnect all ${impact!.accounts}` };
}
