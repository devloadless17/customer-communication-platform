"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Hash, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { toast } from "@/lib/toast";
import type { TeamChannelBrowseItemDto } from "@ccp/shared/team-chat/types";

/**
 * "Browse channels" — the discovery surface for PUBLIC channels, including
 * ones the viewer hasn't joined.
 *
 * The listing is metadata only (name, description, member count) — never
 * message previews — because it's served to non-members. Reading a channel
 * still requires joining it.
 */
export function BrowseChannelsDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<TeamChannelBrowseItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  // Debounced fetch — same 200ms cadence as the other search surfaces.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
      void fetchWithSessionGuard(`/api/team-chat/channels/browse${qs}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((res) => {
          if (cancelled) return;
          setItems((res?.items ?? []) as TeamChannelBrowseItemDto[]);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const join = useCallback(
    async (channelId: string) => {
      setJoiningId(channelId);
      try {
        const res = await fetchWithSessionGuard(
          `/api/team-chat/channels/${channelId}/join`,
          { method: "POST" },
        );
        if (!res.ok) {
          const json = (await res.json().catch(() => ({}))) as { detail?: string };
          toast.error(json.detail ?? "Couldn't join that channel.");
          return;
        }
        // AWAIT the join before navigating. The workspace emits
        // `subscribe:channel` on mount, and the gateway silently no-ops that
        // subscribe if the membership row isn't committed yet — which would
        // leave the user staring at a feed that never receives a live message
        // until they reload.
        onClose();
        router.push(`/team/${channelId}`);
        router.refresh();
      } catch {
        toast.error("Couldn't join that channel.");
      } finally {
        setJoiningId(null);
      }
    },
    [onClose, router],
  );

  return (
    <Dialog open onClose={onClose}>
      <DialogContent className="max-w-lg p-5" ariaLabel="Browse channels">
        <div className="mb-1 text-base font-semibold">Browse channels</div>
        <p className="mb-3 text-xs text-muted-foreground">
          Public channels anyone on the team can join. Private channels are
          invite-only and aren&apos;t listed here.
        </p>

        <div className="relative mb-3">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search channels"
            aria-label="Search channels"
            className="h-8 pl-7 text-sm"
          />
        </div>

        <div className="max-h-96 overflow-y-auto">
          {loading && items.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {query ? "No public channels match that search." : "No public channels yet."}
            </div>
          ) : (
            items.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-accent"
              >
                <Hash className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{c.name}</div>
                  <div className="truncate text-2xs text-muted-foreground">
                    {c.memberCount} {c.memberCount === 1 ? "member" : "members"}
                    {c.description ? ` · ${c.description}` : ""}
                  </div>
                </div>
                {c.joined ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      onClose();
                      router.push(`/team/${c.id}`);
                    }}
                  >
                    Open
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={joiningId !== null}
                    onClick={() => void join(c.id)}
                  >
                    {joiningId === c.id ? "Joining…" : "Join"}
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
