"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

import { API_KEY_SCOPES } from "@ccp/shared/api-keys/scopes";

import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/lib/api/client-fetch";
import type { ApiKeyListItem } from "@/lib/api/queries";

/**
 * General-purpose API key manager — the org-wide counterpart to the
 * integration-specific connect panels (n8n, etc.). Lets an admin mint a
 * single organization key (full access) OR scoped keys, see all active keys,
 * and rotate/revoke them. Backed by the same 4 routes the connect panel
 * uses (POST /api/workspace/api-keys, /:id/rotate, DELETE /:id) so there's no
 * new backend surface — this is the missing UI for the existing capability.
 */

// The granular (non-wildcard) scopes, with short labels for the picker.
const GRANULAR_SCOPES = API_KEY_SCOPES.filter((s) => s !== "*");
const SCOPE_LABELS: Record<string, string> = {
  "read:contacts": "Read contacts",
  "write:contacts": "Write contacts",
  "delete:contacts": "Delete contacts",
  "read:conversations": "Read conversations",
  "write:conversations": "Write conversations (assign / status)",
  "read:messages": "Read messages",
  "write:messages": "Send messages",
  "read:notes": "Read notes",
  "write:notes": "Write notes",
  "read:flags": "Read message flags",
  "write:flags": "Raise / resolve message flags",
  "read:catalog": "Read tags / stages / fields",
  "write:catalog": "Write tags / stages / fields",
  "read:broadcasts": "Read broadcast campaigns + reports",
  "read:calls": "Read call history + calling permission",
  "write:calls": "Request calling permission / send call buttons",
  "write:users": "Legacy — grants nothing (availability moved to Admin settings)",
  "write:workflows": "Fire manual-trigger workflows (runs can send messages)",
  "write:broadcasts": "Launch / cancel / retry campaigns — billed sends, no unsend",
  "read:tickets": "Read tickets + SLA state",
  "write:tickets": "Create / update / resolve tickets",
  "read:channels": "Read connected channel accounts",
  "admin:settings":
    "Admin: assignment rules, ticket settings + SLA, WhatsApp profile & QR",
};

interface Props {
  initialKeys: ApiKeyListItem[];
}

export function ApiKeysManager({ initialKeys }: Props) {
  const [keys, setKeys] = useState<ApiKeyListItem[]>(
    initialKeys.filter((k) => !k.revokedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
  // Sync from SSR re-runs (router.refresh after a create/rotate/revoke) so the
  // list reflects the fresh server snapshot without a manual reload. Same
  // pattern as the tags/stages/snippets catalog managers.
  useEffect(() => {
    setKeys(
      initialKeys.filter((k) => !k.revokedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }, [initialKeys]);
  const [name, setName] = useState("Organization");
  const [fullAccess, setFullAccess] = useState(true);
  const [scopes, setScopes] = useState<Set<string>>(
    // Sensible starting point when an admin switches to custom scopes.
    new Set(["read:contacts", "write:contacts", "read:conversations", "write:conversations", "read:messages", "write:messages", "read:catalog"]),
  );
  const [revealed, setRevealed] = useState<{ id: string; token: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const chosenScopes = fullAccess ? ["*"] : [...scopes];
  const canCreate = name.trim().length > 0 && chosenScopes.length > 0 && !creating;

  async function autoCopy(token: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(token);
      toast.success("Key copied to clipboard");
    } catch {
      toast.info("Couldn't auto-copy — use the Copy button below");
    }
  }

  function toggleScope(scope: string) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function create() {
    if (!canCreate) return;
    setError(null);
    setCreating(true);
    try {
      const res = await apiFetch("/api/workspace/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scopes: chosenScopes }),
      });
      const json = (await res.json()) as Partial<ApiKeyListItem> & { token?: string; error?: string };
      if (!res.ok || !json.id || !json.token) {
        setError(json.error ?? `error ${res.status}`);
        return;
      }
      const row: ApiKeyListItem = {
        id: json.id,
        name: json.name ?? name.trim(),
        tokenPrefix: json.tokenPrefix ?? "",
        createdAt: json.createdAt ?? new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
        scopes: json.scopes ?? chosenScopes,
      };
      setKeys((prev) => [row, ...prev]);
      setRevealed({ id: row.id, token: json.token });
      void autoCopy(json.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setCreating(false);
    }
  }

  async function rotate(key: ApiKeyListItem) {
    const ok = await confirm({
      title: `Rotate the "${key.name}" key?`,
      description: "The old key stops working immediately. Update anything using it with the new key.",
      confirmLabel: "Rotate key",
      destructive: true,
    });
    if (!ok) return;
    setError(null);
    setBusyId(key.id);
    try {
      const res = await apiFetch(`/api/workspace/api-keys/${key.id}/rotate`, { method: "POST" });
      const json = (await res.json()) as Partial<ApiKeyListItem> & { token?: string; error?: string };
      if (!res.ok || !json.id || !json.token) {
        setError(json.error ?? `error ${res.status}`);
        return;
      }
      const row: ApiKeyListItem = {
        id: json.id,
        name: json.name ?? key.name,
        tokenPrefix: json.tokenPrefix ?? "",
        createdAt: json.createdAt ?? new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
        scopes: json.scopes ?? key.scopes,
      };
      // Rotate revokes the old id + mints a new one — swap the row out.
      setKeys((prev) => [row, ...prev.filter((k) => k.id !== key.id)]);
      setRevealed({ id: row.id, token: json.token });
      void autoCopy(json.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(key: ApiKeyListItem) {
    const ok = await confirm({
      title: `Revoke the "${key.name}" key?`,
      description: "Any system using this key will immediately get 401s. This can't be undone.",
      confirmLabel: "Revoke key",
      destructive: true,
    });
    if (!ok) return;
    setError(null);
    setBusyId(key.id);
    try {
      const res = await apiFetch(`/api/workspace/api-keys/${key.id}`, { method: "DELETE" });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error ?? `error ${res.status}`);
        return;
      }
      setKeys((prev) => prev.filter((k) => k.id !== key.id));
      if (revealed?.id === key.id) setRevealed(null);
      toast.success("Key revoked");
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section id="api-keys" className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <KeyRound className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Organization API keys</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            One key for your whole organization, or scoped keys per tool. Every
            request with the key acts within{" "}
            <span className="font-medium">your organization only</span>. Shown in
            plaintext exactly once.
          </p>

          {/* Create form */}
          <div className="mt-4 rounded-md border border-border bg-background p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex-1 text-xs">
                <span className="mb-1 block font-medium text-foreground">Key name</span>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  placeholder="Organization"
                />
              </label>
              <Button type="button" size="sm" onClick={create} disabled={!canCreate}>
                {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                Create key
              </Button>
            </div>

            <div className="mt-3 flex items-center gap-2 text-xs">
              <Switch
                checked={fullAccess}
                onCheckedChange={setFullAccess}
                aria-label="Full access"
              />
              <span className="font-medium">Full access</span>
              <span className="text-muted-foreground">
                (everything in your organization — simplest for a single organization key)
              </span>
            </div>

            {!fullAccess && (
              <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {GRANULAR_SCOPES.map((scope) => (
                  <div key={scope} className="flex items-center gap-2 text-2xs">
                    <Switch
                      checked={scopes.has(scope)}
                      onCheckedChange={() => toggleScope(scope)}
                      aria-label={SCOPE_LABELS[scope] ?? scope}
                    />
                    <span className="text-foreground">{SCOPE_LABELS[scope] ?? scope}</span>
                    <code className="ml-auto rounded bg-muted px-1 py-0.5 font-mono text-3xs text-muted-foreground">
                      {scope}
                    </code>
                  </div>
                ))}
                {chosenScopes.length === 0 && (
                  <p className="col-span-full text-2xs text-destructive">Pick at least one scope.</p>
                )}
              </div>
            )}
          </div>

          {/* Reveal-once token */}
          {revealed && (
            <div className="mt-3 rounded-md border-2 border-warning-border bg-warning-bg p-3 shadow-sm">
              <div className="flex items-start gap-2">
                <KeyRound className="mt-0.5 size-4 shrink-0 text-warning-fg" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-warning-fg">
                    Save your key now — this is the only time it&apos;ll be shown
                  </div>
                  <p className="mt-1 text-2xs text-muted-foreground">
                    Already copied to your clipboard. We only store a hash — if you lose it,
                    use <span className="font-medium">Rotate</span> on the key below.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="block min-w-0 flex-1 select-all break-all rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs">
                      {revealed.token}
                    </code>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void navigator.clipboard.writeText(revealed.token).then(
                          () => toast.success("Copied to clipboard"),
                          () => toast.error("Couldn't access clipboard"),
                        )
                      }
                    >
                      <Copy className="size-3.5" />
                      Copy
                    </Button>
                  </div>
                  <Button type="button" size="sm" onClick={() => setRevealed(null)} className="mt-3">
                    <CheckCircle2 className="size-3.5" />
                    I&apos;ve saved my key
                  </Button>
                </div>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {error}
            </p>
          )}

          {/* Existing keys */}
          <div className="mt-4">
            <div className="mb-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Active keys ({keys.length})
            </div>
            {keys.length === 0 ? (
              <EmptyState
                icon={KeyRound}
                title="No keys yet"
                description="Create one above to start calling the organization API."
              />
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {keys.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
                    <span className="min-w-0 max-w-full truncate text-sm font-medium">{k.name}</span>
                    <code className="shrink-0 font-mono text-2xs text-muted-foreground">{k.tokenPrefix}…</code>
                    <span className="inline-flex items-center gap-1">
                      {k.scopes.includes("*") ? (
                        <code className="rounded bg-primary/10 px-1 py-0.5 font-mono text-3xs text-primary">
                          full access
                        </code>
                      ) : (
                        <code className="rounded bg-muted px-1 py-0.5 font-mono text-3xs text-muted-foreground">
                          {k.scopes.length} scope{k.scopes.length === 1 ? "" : "s"}
                        </code>
                      )}
                    </span>
                    <span className="text-2xs text-muted-foreground">
                      last used{" "}
                      {k.lastUsedAt ? <LocalTime iso={k.lastUsedAt} format="localeString" /> : "never"}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => rotate(k)}
                        disabled={busyId === k.id}
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-3xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                        title="Revoke this key and mint a replacement with the same name + scopes"
                      >
                        {busyId === k.id ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3" />
                        )}
                        Rotate
                      </button>
                      <button
                        type="button"
                        onClick={() => revoke(k)}
                        disabled={busyId === k.id}
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-3xs font-medium text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                        title="Permanently revoke this key"
                      >
                        <Trash2 className="size-3" />
                        Revoke
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      {confirmDialog}
    </section>
  );
}
