"use client";

import { cn } from "@ccp/shared/utils";

import { useChannelAccounts } from "@/features/channels/contexts/channel-accounts-context";
import type { Channel } from "@ccp/shared/types";

/**
 * The ONE way the app names which of your accounts something belongs to.
 *
 * Five surfaces hand-rolled this — the conversation row, the thread header, the
 * calls list, the broadcast detail and the broadcast list — and they had
 * already drifted apart: different markup, different truncation, and the
 * `name (providerName)` tooltip rule copy-pasted four times. Divergence is the
 * problem, not the duplication: an agent who learns that the grey chip means
 * "the number this arrived on" should read the same thing everywhere.
 *
 * THE VISIBILITY RULE lives here and nowhere else. Attribution is a
 * DISAMBIGUATOR: a workspace with one WhatsApp number must look exactly as it
 * did before multi-account, so this renders `null` unless the channel actually
 * holds more than one account. Centralising it means no future call site can
 * forget — which is the same reasoning that made the account resolution itself
 * a single choke point on the server.
 */
export function AccountLabel({
  channel,
  accountId,
  fallbackName = null,
  variant = "chip",
  verb = "Received on",
  showReconnect = false,
  className,
}: {
  channel: Channel | undefined;
  /** `Conversation.channelConnectionId` / `Broadcast.channelConnectionId`. */
  accountId: string | null | undefined;
  /**
   * Server-persisted name for an account that has since been disconnected.
   * Its row is gone from the directory, but the history still belongs to it —
   * rendering nothing there would silently re-attribute the past.
   */
  fallbackName?: string | null;
  /** `chip` for list rows, `inline` for the "· via X" line in a header. */
  variant?: "chip" | "inline";
  /** How the tooltip reads. The verb differs by surface, the shape doesn't. */
  verb?: "Received on" | "Replying from" | "Sent from" | "Calling from";
  /** Thread header only: warn that this account's token is dead. */
  showReconnect?: boolean;
  className?: string;
}) {
  const { showAccountFor, byId } = useChannelAccounts();

  if (!showAccountFor(channel)) return null;

  const account = accountId ? byId.get(accountId) : undefined;
  const name = account?.name ?? fallbackName;
  if (!name) return null;

  const disconnected = !account;
  const title = disconnected
    ? `${verb} ${name} — no longer connected`
    : account.providerName && account.providerName !== account.name
      ? `${verb} ${account.name} (${account.providerName})`
      : `${verb} ${account.name}`;

  const display = shortenAccountName(name);

  if (variant === "inline") {
    return (
      <>
        <span aria-hidden className="text-muted-foreground/50">
          ·
        </span>
        <span className={cn("truncate", className)} title={title}>
          via{" "}
          <span className={cn("font-medium", disconnected ? "text-muted-foreground" : "text-foreground/70")}>
            {display}
          </span>
        </span>
        {showReconnect && account?.needsReconnect && (
          // Trust pill: this account's token is dead, so a reply typed here
          // WILL fail at send. Non-blocking — the server's refusal stays the
          // truth — but the agent shouldn't discover it from a failed bubble.
          <span
            className="inline-flex shrink-0 items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-3xs font-medium text-amber-700 dark:text-amber-400"
            title={`${account.name} has an expired connection — replies will fail until an admin reconnects it in Settings.`}
          >
            reconnect needed
          </span>
        )}
      </>
    );
  }

  return (
    <span
      title={title}
      className={cn(
        "shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs",
        disconnected ? "text-muted-foreground/70 line-through" : "text-muted-foreground",
        className,
      )}
    >
      {display}
    </span>
  );
}

/**
 * Phone-shaped labels keep their LAST digits, not their first.
 *
 * An unlabelled WhatsApp account displays as its E.164 number, and two numbers
 * on one workspace usually share a country and carrier prefix — so ordinary
 * CSS truncation ate exactly the digits that tell them apart and rendered two
 * different accounts as the same ellipsised string. The full value stays in the
 * tooltip. Anything an admin has actually named is left alone: a real label is
 * chosen to be distinguishable already.
 */
function shortenAccountName(name: string): string {
  if (name.length <= 14) return name;
  if (!/^\+?[\d\s()-]+$/.test(name)) return name;
  const digits = name.replace(/\D/g, "");
  return digits.length > 4 ? `…${digits.slice(-4)}` : name;
}
