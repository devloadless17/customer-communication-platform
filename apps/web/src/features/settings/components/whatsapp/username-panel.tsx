"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AtSign, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import {
  WHATSAPP_USERNAME_MAX,
  checkWhatsappUsername,
} from "@ccp/shared/whatsapp/username";
import { cn } from "@ccp/shared/utils";

/**
 * The number's WhatsApp @username — a chat-native handle customers can use
 * instead of the phone number (which stays visible; adopting a username does
 * not hide it). 1:1 with the phone number, globally unique across WhatsApp.
 *
 * Loaded lazily on expand like the business-profile panel: it costs two Graph
 * reads (current username + Meta's reserved suggestions).
 *
 * Validation mirrors Meta's published rules via the SHARED checker
 * (@ccp/shared/whatsapp/username) — the same one the API enforces — so what
 * passes here passes there; Meta stays the final authority (taken names,
 * reserved words). The one conflict with a flow: Graph 147005 means the name is
 * already on a SIBLING number of the same portfolio, surfaced by the API as a
 * 409 `username_transfer_required` — we confirm, then re-send with
 * `transferAction: "force_transfer"`.
 */

interface UsernameState {
  username: string | null;
  suggestions: string[];
}

export function UsernamePanel({
  canManage,
  /** Which number's username. Omitted = the workspace's default number. */
  accountId,
}: {
  canManage: boolean;
  accountId?: string;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<UsernameState | null>(null);
  const [draft, setDraft] = useState("");

  const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/whatsapp/username${query}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        throw new Error(
          [data?.error, data?.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      const data = (await res.json()) as UsernameState;
      setState(data);
      setDraft(data.username ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load the username");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    if (open && state === null && !loading) void load();
  }, [open, state, loading, load]);

  // Live validation against the SAME rules the server enforces. Untouched or
  // unchanged input shows no noise.
  const check = useMemo(() => checkWhatsappUsername(draft), [draft]);
  const dirty = check.normalized !== (state?.username ?? "");
  const showRuleFeedback = dirty && draft.trim().length > 0;

  async function save(transferAction?: "force_transfer") {
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/whatsapp/username${query}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: check.normalized,
          ...(transferAction ? { transferAction } : {}),
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        // The one recoverable conflict: the name is on a sibling number of the
        // same portfolio. Offer the transfer explicitly — the other number
        // loses its handle, so this must never happen silently.
        if (res.status === 409 && data?.error === "username_transfer_required") {
          setSaving(false);
          const ok = await confirm({
            title: "Move this username here?",
            description:
              `@${check.normalized} already belongs to another of your WhatsApp ` +
              "numbers in the same business portfolio. Moving it here takes it " +
              "away from that number.",
            confirmLabel: "Move username",
            destructive: true,
          });
          if (ok) await save("force_transfer");
          return;
        }
        throw new Error(
          [data?.error, data?.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      const data = (await res.json()) as { username: string };
      setState((s) => ({ username: data.username, suggestions: s?.suggestions ?? [] }));
      setDraft(data.username);
      toast.success(`Username set to @${data.username}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the username");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: "Remove this username?",
      description:
        "Customers who saved or shared your @username lose that way of reaching " +
        "this chat. Your phone number keeps working.",
      confirmLabel: "Remove username",
      destructive: true,
    });
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/whatsapp/username${query}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as
          | { error?: string; detail?: string }
          | null;
        throw new Error(
          [data?.error, data?.detail].filter(Boolean).join(": ") || `HTTP ${res.status}`,
        );
      }
      setState((s) => ({ username: null, suggestions: s?.suggestions ?? [] }));
      setDraft("");
      toast.success("Username removed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove the username");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <div className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <AtSign className="size-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Username</div>
          <div className="text-2xs text-muted-foreground">
            A chat handle customers can use instead of your phone number
          </div>
        </div>
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </button>

      {open && (
        <div className="border-t border-border px-4 py-4">
          {error && (
            <p className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {state && (
            <div className="flex flex-col gap-3">
              <p className="text-2xs text-muted-foreground">
                {state.username ? (
                  <>
                    This number is <span className="font-mono text-foreground">@{state.username}</span>.
                    Usernames are unique across WhatsApp, and your phone number
                    stays visible either way.
                  </>
                ) : (
                  <>
                    No username yet. One handle per number, unique across
                    WhatsApp — and your phone number stays visible either way.
                  </>
                )}
              </p>

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="wa-username"
                  className="text-2xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  Username
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute inset-y-0 left-0 flex w-8 items-center justify-center text-sm text-muted-foreground">
                    @
                  </span>
                  <Input
                    id="wa-username"
                    value={draft}
                    disabled={!canManage || saving}
                    maxLength={WHATSAPP_USERNAME_MAX}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="my.business"
                    className="pl-8 font-mono text-sm"
                  />
                </div>
                <p className="text-2xs text-muted-foreground">
                  3–35 characters: letters, numbers, periods and underscores.
                  Case doesn&apos;t matter; <span className="font-mono">.</span> and{" "}
                  <span className="font-mono">_</span> do.
                </p>
                {showRuleFeedback &&
                  check.errors.map((e) => (
                    <p key={e} className="text-2xs text-destructive">
                      {e}
                    </p>
                  ))}
                {showRuleFeedback &&
                  check.ok &&
                  check.warnings.map((w) => (
                    <p key={w} className="text-2xs text-amber-700 dark:text-amber-400">
                      {w}
                    </p>
                  ))}
              </div>

              {state.suggestions.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    Suggestions
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {state.suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        disabled={!canManage || saving}
                        onClick={() => setDraft(s)}
                        className={cn(
                          "rounded-full border px-3 py-1 font-mono text-xs transition",
                          s === check.normalized
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        @{s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {canManage && (
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void save()}
                    disabled={saving || !dirty || !check.ok || draft.trim().length === 0}
                  >
                    {saving ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                    {state.username ? "Change username" : "Set username"}
                  </Button>
                  {state.username && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={saving}
                      onClick={() => void remove()}
                    >
                      <Trash2 className="size-3.5" />
                      Remove
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {confirmDialog}
    </section>
  );
}
