"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Star, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import type { ChannelAccountView } from "@/lib/api/queries";
import { apiFetch } from "@/lib/api/client-fetch";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import { cn } from "@ccp/shared/utils";

/**
 * Connected accounts for one channel.
 *
 * Only rendered when a workspace has MORE THAN ONE account on the channel — a
 * single-account workspace sees the existing connection card unchanged, so
 * nothing about the common setup gets busier.
 *
 * The panel manages existing accounts (label / default / disconnect). ADDING an
 * account is the channel's normal connect form: it upserts on the provider's
 * account id, so pasting a second number's credentials creates a second account
 * rather than overwriting the first.
 */
export function ChannelAccountsPanel({
  channel,
  accounts,
  channelLabel,
}: {
  channel: "whatsapp" | "messenger" | "instagram";
  accounts: ChannelAccountView[];
  channelLabel: string;
}) {
  const refresh = useSoftRefresh();
  const { confirm, confirmDialog } = useConfirm();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [, startTransition] = useTransition();

  if (accounts.length <= 1) return null;

  async function call(id: string, path: string, init: RequestInit) {
    setPendingId(id);
    try {
      const res = await apiFetch(`/api/workspace/channels/${channel}/accounts/${path}`, init);
      if (res.ok) startTransition(() => refresh());
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      {confirmDialog}
      <div className="mb-1 text-sm font-semibold">Connected {channelLabel} accounts</div>
      <p className="mb-3 text-2xs text-muted-foreground">
        New conversations reply from the account the customer messaged. The default is used
        only when starting a conversation yourself, and for broadcasts.
      </p>

      <ul className="flex flex-col gap-1.5">
        {accounts.map((a) => {
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
                </div>
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
                      const ok = await confirm({
                        title: `Disconnect ${name}?`,
                        // Say plainly what happens to live threads — the one
                        // thing that is NOT obvious and is not reversible by
                        // simply re-adding the account.
                        description:
                          "Its credentials are removed. Existing conversations are kept, but " +
                          "can't be replied to until they're reconnected to an account — they " +
                          "are deliberately not moved to another number.",
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
  );
}
