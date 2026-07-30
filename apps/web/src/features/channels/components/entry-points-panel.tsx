"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquareText, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

/**
 * CONVERSATION ENTRY POINTS — the ice breakers and persistent menu a customer
 * sees BEFORE they have typed anything.
 *
 * Channel-parameterised because it is literally the same `messenger_profile`
 * node behind both Messenger and Instagram, with the same two caps and the same
 * clearing semantics. It lives in `features/channels/` and hardcoded Instagram's
 * endpoint, which made "shared component" only true by location.
 *
 * Read-through / write-through to Meta, with no local mirror: these can also be
 * edited in Business Suite, so a cached copy would start lying the moment
 * someone did. The panel therefore fetches on mount and re-renders from what the
 * save actually returned, not from what it sent.
 *
 * The load-bearing UX rule: when the read FAILS we render an error, never an
 * empty editor. An empty editor invites a save, and an empty save CLEARS a live
 * configuration — so a transient Graph blip would silently delete the account's
 * whole front door.
 */
export interface IceBreaker {
  question: string;
  payload: string;
}
export type MenuItem =
  | { type: "web_url"; title: string; url: string }
  | { type: "postback"; title: string; payload: string };
export interface EntryPoints {
  iceBreakers: IceBreaker[];
  menuItems: MenuItem[];
}

/** Meta's documented caps — 4 ice breakers, "limit to 5" menu items. */
const MAX_ICE_BREAKERS = 4;
const MAX_MENU_ITEMS = 5;

/** The channels whose capabilities declare `entryPoints`. */
export type EntryPointsChannel = "messenger" | "instagram";

const CHANNEL_LABEL: Record<EntryPointsChannel, string> = {
  messenger: "Messenger",
  instagram: "Instagram",
};

export function EntryPointsPanel({
  channel,
  accountId,
}: {
  channel: EntryPointsChannel;
  accountId?: string;
}) {
  const label = CHANNEL_LABEL[channel];
  const endpoint = `/api/workspace/${channel}/entry-points`;
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [iceBreakers, setIceBreakers] = useState<IceBreaker[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
      const res = await apiFetch(`${endpoint}${qs}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { entryPoints: EntryPoints | null };
      if (!body.entryPoints) {
        setLoadFailed(true);
        return;
      }
      setIceBreakers(body.entryPoints.iceBreakers);
      setMenuItems(body.entryPoints.menuItems);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [accountId, endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      const res = await apiFetch(endpoint, {
        method: "POST",
        // apiFetch sets no content-type of its own — say it explicitly or Nest
        // never parses the body.
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(accountId ? { accountId } : {}),
          iceBreakers,
          menuItems,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { entryPoints?: EntryPoints | null; detail?: string; error?: string }
        | null;
      if (!res.ok) {
        toast.error(body?.detail ?? body?.error ?? "Couldn't save the entry points.");
        return;
      }
      // Show what Meta actually applied, not what we asked for.
      if (body?.entryPoints) {
        setIceBreakers(body.entryPoints.iceBreakers);
        setMenuItems(body.entryPoints.menuItems);
      }
      toast.success(`${label} entry points updated.`);
    } catch {
      toast.error("Couldn't reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-5">
      <div className="mb-1 flex items-center gap-2">
        <MessageSquareText className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Conversation starters</h2>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        What someone sees on {label} before they type. Ice breakers are the
        questions shown in an empty chat (up to {MAX_ICE_BREAKERS}); the menu is
        always available from the chat (up to {MAX_MENU_ITEMS}). A tap arrives in
        your inbox as a normal message and can trigger a workflow.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Reading the current setup from {label}…
        </div>
      ) : loadFailed ? (
        // Deliberately NOT an empty editor — see the docblock.
        <div className="flex flex-col items-start gap-2 rounded-lg border border-warning-border bg-warning-bg p-3">
          <p className="text-xs text-warning-fg">
            Couldn&apos;t read the current conversation starters from {label}.
            Nothing is shown rather than an empty form, because saving an empty
            form would erase whatever is live right now.
          </p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Ice breakers ({iceBreakers.length}/{MAX_ICE_BREAKERS})
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={iceBreakers.length >= MAX_ICE_BREAKERS}
                onClick={() =>
                  setIceBreakers((prev) => [...prev, { question: "", payload: "" }])
                }
              >
                <Plus className="mr-1 size-3.5" />
                Add
              </Button>
            </div>
            {iceBreakers.length === 0 && (
              <p className="text-2xs text-muted-foreground">None set.</p>
            )}
            {iceBreakers.map((ib, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  value={ib.question}
                  onChange={(e) =>
                    setIceBreakers((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)),
                    )
                  }
                  placeholder="Where is my order?"
                  maxLength={80}
                  className="text-xs"
                  aria-label={`Ice breaker ${i + 1} question`}
                />
                <Input
                  value={ib.payload}
                  onChange={(e) =>
                    setIceBreakers((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, payload: e.target.value } : x)),
                    )
                  }
                  placeholder="payload id"
                  className="w-40 text-xs"
                  aria-label={`Ice breaker ${i + 1} payload`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ice breaker ${i + 1}`}
                  onClick={() => setIceBreakers((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Persistent menu ({menuItems.length}/{MAX_MENU_ITEMS})
              </span>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={menuItems.length >= MAX_MENU_ITEMS}
                  onClick={() =>
                    setMenuItems((prev) => [
                      ...prev,
                      { type: "postback", title: "", payload: "" },
                    ])
                  }
                >
                  <Plus className="mr-1 size-3.5" />
                  Button
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={menuItems.length >= MAX_MENU_ITEMS}
                  onClick={() =>
                    setMenuItems((prev) => [...prev, { type: "web_url", title: "", url: "" }])
                  }
                >
                  <Plus className="mr-1 size-3.5" />
                  Link
                </Button>
              </div>
            </div>
            {menuItems.length === 0 && (
              <p className="text-2xs text-muted-foreground">None set.</p>
            )}
            {menuItems.map((item, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  value={item.title}
                  onChange={(e) =>
                    setMenuItems((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
                    )
                  }
                  placeholder="Menu label"
                  maxLength={30}
                  className="text-xs"
                  aria-label={`Menu item ${i + 1} label`}
                />
                <Input
                  value={item.type === "web_url" ? item.url : item.payload}
                  onChange={(e) =>
                    setMenuItems((prev) =>
                      prev.map((x, j) =>
                        j !== i
                          ? x
                          : x.type === "web_url"
                            ? { ...x, url: e.target.value }
                            : { ...x, payload: e.target.value },
                      ),
                    )
                  }
                  placeholder={item.type === "web_url" ? "https://…" : "payload id"}
                  className="w-56 text-xs"
                  aria-label={`Menu item ${i + 1} ${item.type === "web_url" ? "URL" : "payload"}`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove menu item ${i + 1}`}
                  onClick={() => setMenuItems((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </section>

          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Save to {label}
            </Button>
            <span className="text-2xs text-muted-foreground">
              Removing every row clears that section on {label}.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
