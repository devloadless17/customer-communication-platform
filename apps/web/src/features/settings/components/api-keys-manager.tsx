"use client";

import { useEffect, useState } from "react";
import { Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { toast } from "@/lib/toast";

interface ApiKey {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface Props {
  initialKeys: ApiKey[];
}

export function ApiKeysManager({ initialKeys }: Props) {
  const [keys, setKeys] = useState<ApiKey[]>(initialKeys);
  // Sync from SSR (router.refresh from useCatalogSync) so teammate
  // additions/revocations show up without manual refresh.
  useEffect(() => {
    setKeys(initialKeys);
  }, [initialKeys]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ id: string; token: string } | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!newName.trim()) {
      setError("name required");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/team/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const json = (await res.json()) as {
        id?: string;
        name?: string;
        tokenPrefix?: string;
        createdAt?: string;
        token?: string;
        error?: string;
      };
      if (!res.ok || !json.id || !json.token) {
        setError(json.error ?? `error ${res.status}`);
        return;
      }
      setKeys((prev) => [
        {
          id: json.id!,
          name: json.name!,
          tokenPrefix: json.tokenPrefix!,
          createdAt: json.createdAt!,
          lastUsedAt: null,
          revokedAt: null,
        },
        ...prev,
      ]);
      setRevealed({ id: json.id, token: json.token });
      setNewName("");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(key: ApiKey) {
    const ok = await confirm({
      title: `Revoke "${key.name}"?`,
      description: "Any integrations using this key will start receiving 401s immediately. You'll need to create a new key to re-enable them.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/team/api-keys/${key.id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error("Revoke failed", { description: `HTTP ${res.status}` });
      return;
    }
    setKeys((prev) =>
      prev.map((k) => (k.id === key.id ? { ...k, revokedAt: new Date().toISOString() } : k)),
    );
    toast.success(`Revoked "${key.name}"`);
  }

  function copyRevealed() {
    if (!revealed) return;
    void navigator.clipboard.writeText(revealed.token).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Couldn't access clipboard"),
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Create */}
      <form onSubmit={createKey} className="flex flex-col gap-3 rounded-md border border-border p-4">
        <label className="text-sm font-medium">Create a new key</label>
        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="n8n production"
            maxLength={80}
            className="flex-1"
            required
          />
          <Button type="submit" disabled={creating}>
            {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Create
          </Button>
        </div>
        {error && <div className="text-xs text-destructive">{error}</div>}
      </form>

      {/* Reveal banner — shown ONCE per key */}
      {revealed && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4">
          <div className="flex items-start gap-3">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Copy your key now</div>
              <p className="mt-1 text-xs text-muted-foreground">
                This is the only time the full token will be displayed. Store it in your
                integration's secret store; we keep only a hash.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <code className="block min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs">
                  {revealed.token}
                </code>
                <Button type="button" size="sm" variant="outline" onClick={copyRevealed}>
                  <Copy className="size-3.5" />
                  Copy
                </Button>
              </div>
              <button
                type="button"
                onClick={() => setRevealed(null)}
                className="mt-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      <div className="flex flex-col gap-2">
        <div className="text-sm font-medium">Your keys</div>
        {keys.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
            No keys yet.
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-border rounded-md border border-border">
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <KeyRound className="size-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="truncate font-medium">{k.name}</span>
                    {k.revokedAt && (
                      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        revoked
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    <code className="font-mono">{k.tokenPrefix}…</code>
                    <span>
                      created <LocalTime iso={k.createdAt} format="localeDate" />
                    </span>
                    <span>
                      last used{" "}
                      {k.lastUsedAt ? (
                        <LocalTime iso={k.lastUsedAt} format="localeString" />
                      ) : (
                        "never"
                      )}
                    </span>
                  </div>
                </div>
                {!k.revokedAt && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => revoke(k)}
                  >
                    <Trash2 className="size-4" />
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {confirmDialog}
    </div>
  );
}
