"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { ChannelBadge } from "@/features/inbox/components/channel-badge";
import { useChannelAccounts } from "@/features/channels/contexts/channel-accounts-context";
import { useInboxFilter } from "@/features/inbox/contexts/inbox-filter-context";
import { cn } from "@ccp/shared/utils";

/**
 * Narrow the inbox to ONE channel account — a specific WhatsApp number,
 * Facebook Page or Instagram handle.
 *
 * The inbox is UNIFIED by default and stays that way: every account's
 * conversations in one list, each row labelled with the number it arrived on.
 * This section narrows on demand. It is not a per-number inbox, and "All
 * accounts" is always the first entry and the state you land on each session —
 * a remembered narrow is a silent trap (an agent returns to an inbox missing
 * every conversation on the other numbers, with no reason to suspect a filter).
 *
 * RENDERS NOTHING unless the workspace actually has more than one account on
 * some channel. With a single number there is nothing to disambiguate, and a
 * one-entry filter is pure clutter — the same rule the row-level attribution
 * chip follows.
 *
 * Orthogonal to the preset/stage/view selection above it: picking "Sales" does
 * not clear "Unassigned". They answer different questions and compose.
 */
export function InboxAccountsSection() {
  const { byId, hasMultipleFor } = useChannelAccounts();
  const { accountId, setAccountId } = useInboxFilter();
  const [open, setOpen] = useState(true);

  const accounts = [...byId.values()]
    // Only channels that genuinely have several accounts — an Instagram handle
    // sitting alone alongside two WhatsApp numbers is not a choice worth making.
    // `hasMultipleFor`, NOT `showAccountFor`: attribution now names even a single
    // account, but a one-entry filter is still clutter.
    .filter((a) => hasMultipleFor(a.channel))
    .sort((a, b) =>
      a.channel === b.channel ? a.name.localeCompare(b.name) : a.channel.localeCompare(b.channel),
    );

  if (accounts.length === 0) return null;

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-1.5 px-4 pb-1 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <span className="flex-1 truncate">Accounts</span>
        {/* When a narrow is active it must be visible even COLLAPSED — a hidden
            active filter is the whole failure mode this section risks. */}
        {!open && accountId && (
          <span className="truncate rounded bg-primary/10 px-1.5 py-px text-3xs font-medium normal-case tracking-normal text-primary">
            {byId.get(accountId)?.name ?? "1 selected"}
          </span>
        )}
      </button>

      {open && (
        <ul className="flex flex-col gap-px px-2">
          <li>
            <button
              type="button"
              onClick={() => setAccountId(null)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                accountId === null
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-foreground/80 hover:bg-accent",
              )}
            >
              All accounts
            </button>
          </li>

          {accounts.map((a) => {
            const active = accountId === a.id;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => setAccountId(active ? null : a.id)}
                  title={
                    a.providerName && a.providerName !== a.name
                      ? `${a.name} · ${a.providerName}`
                      : a.name
                  }
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    active
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-foreground/80 hover:bg-accent",
                    // A disconnected account keeps its threads, so it stays
                    // filterable — but it can't receive or send, and saying so
                    // beats an agent wondering why the list is frozen.
                    !a.isActive && "opacity-60",
                  )}
                >
                  <ChannelBadge channel={a.channel} className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  {!a.isActive && (
                    <span className="shrink-0 text-3xs text-muted-foreground">disconnected</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
