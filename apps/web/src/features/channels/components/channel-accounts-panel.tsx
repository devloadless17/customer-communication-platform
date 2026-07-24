"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Plus, Star, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { ChannelAccountView } from "@/lib/api/queries";
import { apiFetch } from "@/lib/api/client-fetch";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { cn } from "@ccp/shared/utils";
import { AccountHealthRow } from "./account-health-row";
import { PortfolioSummary } from "./portfolio-summary";

/**
 * Connected accounts for one channel.
 *
 * Rendered as soon as the channel has ONE account, not two. It used to hide
 * below two, which produced a chicken-and-egg: multi-account was fully built in
 * the backend, but nothing in the UI ever said so — an admin looking at
 * Settings → WhatsApp saw one connection card and reasonably concluded the
 * product supported one number. The only way to discover otherwise was to guess
 * that a form labelled "Update credentials" would in fact ADD a number.
 *
 * So the panel now states the count, and carries the explicit "Add another"
 * affordance. Adding is still the channel's normal connect form — it upserts on
 * the provider's account id, so pasting a second number's credentials creates a
 * second account rather than overwriting the first — the button just scrolls to
 * it and says what it will do.
 */
interface RemovalImpact {
  conversations: number;
  openConversations: number;
  scheduledBroadcasts: number;
}

/**
 * Read the cost of disconnecting. Returns null on failure — the dialog then
 * falls back to the generic warning rather than blocking the action, because a
 * transient read failure must not make an account undeletable.
 */
async function fetchRemovalImpact(
  channel: string,
  id: string,
): Promise<RemovalImpact | null> {
  try {
    const res = await apiFetch(
      `/api/workspace/channels/${channel}/accounts/${id}/removal-impact`,
    );
    if (!res.ok) return null;
    return (await res.json()) as RemovalImpact;
  } catch {
    return null;
  }
}

export function ChannelAccountsPanel({
  channel,
  accounts,
  channelLabel,
  accountNoun,
  onAddAnother,
}: {
  channel: "whatsapp" | "messenger" | "instagram";
  accounts: ChannelAccountView[];
  channelLabel: string;
  /** What one account IS on this channel — "number", "Page", "account". */
  accountNoun: string;
  /**
   * Reveal + focus the channel's connect form. A callback rather than a scroll
   * target because on Messenger/Instagram the form is COLLAPSED once connected —
   * scrolling to a hidden element would look like the button did nothing.
   */
  onAddAnother: () => void;
}) {
  const refresh = useSoftRefresh();
  const { confirm, confirmDialog } = useConfirm();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [, startTransition] = useTransition();

  // Nothing connected yet — the connect form IS the page, and a panel saying
  // "0 accounts" above it would be pure noise.
  if (accounts.length === 0) return null;

  async function call(id: string, path: string, init: RequestInit) {
    setPendingId(id);
    try {
      const res = await apiFetch(`/api/workspace/channels/${channel}/accounts/${path}`, init);
      if (res.ok) startTransition(() => refresh());
    } finally {
      setPendingId(null);
    }
  }

  // Group by portfolio so a shared 24h budget is stated ONCE. Accounts with no
  // resolved portfolio (or on a channel that has none) fall into a single
  // trailing group keyed "none" — they are still listed, just without a shared
  // header claiming a budget we could not read.
  const groups = (() => {
    const byKey = new Map<
      string,
      { key: string; portfolio: ChannelAccountView["health"] extends null ? never : NonNullable<ChannelAccountView["health"]>["portfolio"]; accounts: ChannelAccountView[] }
    >();
    for (const a of accounts) {
      const portfolio = a.health?.portfolio ?? null;
      const key = portfolio?.externalId ?? "none";
      const existing = byKey.get(key);
      if (existing) existing.accounts.push(a);
      else byKey.set(key, { key, portfolio, accounts: [a] });
    }
    // "none" last — a resolved portfolio is the more informative group.
    return [...byKey.values()].sort((x, y) =>
      x.key === "none" ? 1 : y.key === "none" ? -1 : 0,
    );
  })();

  return (
    <div className="rounded-xl border bg-card p-4">
      {confirmDialog}
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold">
          Connected {channelLabel} {accounts.length === 1 ? accountNoun : `${accountNoun}s`}
          <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">
            {accounts.length}
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1 px-2 text-2xs"
          onClick={onAddAnother}
        >
          <Plus aria-hidden className="size-3.5" />
          Add another {accountNoun}
        </Button>
      </div>
      <p className="mb-3 text-2xs text-muted-foreground">
        A workspace can connect several {channelLabel} {accountNoun}s. Replies always go out
        the {accountNoun} the customer messaged; the default is used only when you start a
        conversation yourself, and for broadcasts. To add one, fill the connect form below
        with the new {accountNoun}&apos;s credentials — it adds rather than replaces.
      </p>

      {groups.map((group) => (
        <div key={group.key} className="mb-3 flex flex-col gap-1.5 last:mb-0">
          {/* WhatsApp only: the budget + template limit belong to the PORTFOLIO
              and are shared, so they are stated once per group rather than
              repeated under every number (which reads as separate budgets). */}
          {channel === "whatsapp" && (
            <PortfolioSummary
              portfolio={group.portfolio}
              accountsInGroup={group.accounts.length}
            />
          )}
      <ul className="flex flex-col gap-1.5">
        {group.accounts.map((a) => {
          const busy = pendingId === a.id;
          const name =
            a.label ?? a.displayPhoneNumber ?? a.externalAccountId ?? "Unnamed account";
          return (
            <li
              key={a.id}
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-2",
                a.isDefault && "border-primary/40 bg-primary/5",
              )}
            >
              <div className="min-w-0 flex-1">
                {editing === a.id ? (
                  <form
                    className="flex items-center gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      setEditing(null);
                      void call(a.id, a.id, {
                        method: "PATCH",
                        body: JSON.stringify({ label: draftLabel.trim() || null }),
                      });
                    }}
                  >
                    <Input
                      autoFocus
                      value={draftLabel}
                      onChange={(e) => setDraftLabel(e.target.value)}
                      placeholder="e.g. Sales line"
                      maxLength={60}
                      className="h-7 text-xs"
                    />
                    <Button type="submit" size="sm" variant="ghost" className="h-7 px-2">
                      <Check aria-hidden className="size-3.5" />
                      <span className="sr-only">Save name</span>
                    </Button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="truncate text-left text-sm font-medium hover:underline"
                    onClick={() => {
                      setEditing(a.id);
                      setDraftLabel(a.label ?? "");
                    }}
                  >
                    {name}
                  </button>
                )}
                <div className="truncate text-3xs text-muted-foreground">
                  {a.displayPhoneNumber ? `${a.displayPhoneNumber} · ` : ""}
                  {a.externalAccountId}
                  {a.wabaId ? ` · WABA ${a.wabaId}` : ""}
                </div>
                {a.health && <AccountHealthRow health={a.health} />}
              </div>

              {a.isDefault && (
                <Badge variant="muted" className="shrink-0 px-1.5 py-0 text-3xs">
                  Default
                </Badge>
              )}
              {a.needsReconnect && (
                <Badge variant="muted" className="shrink-0 px-1.5 py-0 text-3xs text-warning-fg">
                  Reconnect
                </Badge>
              )}

              {busy ? (
                <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" />
              ) : (
                <>
                  {!a.isDefault && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 px-2 text-2xs"
                      onClick={() => void call(a.id, `${a.id}/default`, { method: "POST" })}
                    >
                      <Star aria-hidden className="mr-1 size-3.5" />
                      Make default
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 shrink-0 px-2 text-destructive"
                    onClick={async () => {
                      // Ask the server what this actually costs FIRST. "Existing
                      // conversations are kept but can't be replied to" is true
                      // and unweighable — an admin needs to know whether that is
                      // 2 threads or 2,000, and whether a queued campaign is
                      // about to fail every recipient.
                      const impact = await fetchRemovalImpact(channel, a.id);
                      const lines = [
                        `Its credentials are removed. Conversations are kept, but can't be replied to until they're reconnected — they are deliberately NOT moved to another ${accountNoun}.`,
                      ];
                      if (impact) {
                        if (impact.conversations > 0) {
                          lines.push(
                            `${impact.conversations.toLocaleString()} conversation${impact.conversations === 1 ? "" : "s"} are on this ${accountNoun}` +
                              (impact.openConversations > 0
                                ? ` — ${impact.openConversations.toLocaleString()} still open.`
                                : "."),
                          );
                        } else {
                          lines.push(`No conversations are on this ${accountNoun}.`);
                        }
                        if (impact.scheduledBroadcasts > 0) {
                          lines.push(
                            `${impact.scheduledBroadcasts} broadcast${impact.scheduledBroadcasts === 1 ? "" : "s"} scheduled from this ${accountNoun} will fail for every recipient.`,
                          );
                        }
                      }
                      const ok = await confirm({
                        title: `Disconnect ${name}?`,
                        description: lines.join(" "),
                        confirmLabel: "Disconnect",
                        destructive: true,
                      });
                      if (ok) void call(a.id, a.id, { method: "DELETE" });
                    }}
                  >
                    <Trash2 aria-hidden className="size-3.5" />
                    <span className="sr-only">Disconnect {name}</span>
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
        </div>
      ))}
    </div>
  );
}
