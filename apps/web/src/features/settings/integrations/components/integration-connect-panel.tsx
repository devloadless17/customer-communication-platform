"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Copy, KeyRound, Loader2, RefreshCw, Terminal, Zap } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/lib/api/client-fetch";
import type { ApiKeyListItem } from "@/lib/api/queries";

import type { CurlExample, IntegrationPreset } from "../presets";

interface Props {
  preset: IntegrationPreset;
  /** Pre-fetched team key list, used to detect "already connected" state. */
  initialKeys: ApiKeyListItem[];
  /**
   * Rendered below the connect button on success (and inline on the
   * already-connected state). Should be a short setup snippet specific
   * to this tool — header name, endpoint hints, etc.
   */
  instructions: React.ReactNode;
}

export function IntegrationConnectPanel({ preset, initialKeys, instructions }: Props) {
  // Active (non-revoked) key whose name matches the preset — that's our
  // "is this integration already connected" signal. Multiple matches
  // shouldn't happen via this flow (we block create when one exists),
  // but if an admin manually created a key with the same name, the
  // most-recent one wins as the displayed source of truth.
  const existing =
    initialKeys
      .filter((k) => !k.revokedAt && k.name === preset.defaultName)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

  const [connected, setConnected] = useState<ApiKeyListItem | null>(existing);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  // Filled in after mount — `window` isn't available during the SSR pass,
  // and we want the curls to use the user's actual host (works against
  // localhost, staging, and prod without per-env overrides).
  const [origin, setOrigin] = useState<string>("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  /**
   * Belt-and-braces against the "I forgot to copy it" trap: the plaintext is
   * shoved onto the clipboard the instant we receive it from the server.
   * Failure is non-fatal — the reveal stays on screen with a manual Copy
   * button. We surface the result as a toast so the user knows the
   * auto-grab happened (or didn't).
   */
  async function autoCopy(token: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(token);
      toast.success("Key copied to clipboard");
    } catch {
      toast.info("Couldn't auto-copy — use the Copy button below");
    }
  }

  async function generate() {
    setError(null);
    setGenerating(true);
    try {
      const res = await apiFetch("/api/team/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: preset.defaultName,
          scopes: preset.recommendedScopes,
        }),
      });
      const json = (await res.json()) as {
        id?: string;
        name?: string;
        tokenPrefix?: string;
        createdAt?: string;
        scopes?: string[];
        token?: string;
        error?: string;
      };
      if (!res.ok || !json.id || !json.token) {
        setError(json.error ?? `error ${res.status}`);
        return;
      }
      setConnected({
        id: json.id,
        name: json.name ?? preset.defaultName,
        tokenPrefix: json.tokenPrefix ?? "",
        createdAt: json.createdAt ?? new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
        scopes: json.scopes ?? preset.recommendedScopes,
      });
      setRevealed(json.token);
      void autoCopy(json.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setGenerating(false);
    }
  }

  /**
   * Lost-the-plaintext recovery: revoke the existing key + create a new one
   * in the same atomic call, then show the new plaintext. The integration
   * (n8n etc.) only needs its Authorization header updated; the existing
   * scopes and name carry over.
   */
  async function rotate() {
    if (!connected) return;
    const ok = await confirm({
      title: `Rotate the "${connected.name}" key?`,
      description: `The old key stops working immediately. You'll need to paste the new key into ${preset.label}.`,
      confirmLabel: "Rotate key",
      destructive: true,
    });
    if (!ok) return;
    setError(null);
    setRotating(true);
    try {
      const res = await apiFetch(`/api/team/api-keys/${connected.id}/rotate`, {
        method: "POST",
      });
      const json = (await res.json()) as {
        id?: string;
        name?: string;
        tokenPrefix?: string;
        createdAt?: string;
        scopes?: string[];
        token?: string;
        error?: string;
      };
      if (!res.ok || !json.id || !json.token) {
        setError(json.error ?? `error ${res.status}`);
        return;
      }
      setConnected({
        id: json.id,
        name: json.name ?? preset.defaultName,
        tokenPrefix: json.tokenPrefix ?? "",
        createdAt: json.createdAt ?? new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
        scopes: json.scopes ?? preset.recommendedScopes,
      });
      setRevealed(json.token);
      void autoCopy(json.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setRotating(false);
    }
  }

  function copyToken() {
    if (!revealed) return;
    void navigator.clipboard.writeText(revealed).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Couldn't access clipboard"),
    );
  }

  return (
    <section
      id={preset.key}
      className="rounded-lg border border-border bg-card p-5"
    >
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Zap className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Connect {preset.label}</h2>
            {connected && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wide text-emerald-600">
                <CheckCircle2 className="size-3" />
                Connected
              </span>
            )}
          </div>

          {!connected && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Generate a scoped API key with just the permissions{" "}
              {preset.label} needs. Shown in plaintext exactly once.
            </p>
          )}

          {connected && !revealed && (
            <div className="mt-2 flex flex-wrap items-center gap-3 text-2xs text-muted-foreground">
              <code className="font-mono">{connected.tokenPrefix}…</code>
              <span>
                created <LocalTime iso={connected.createdAt} format="localeDate" />
              </span>
              <span>
                last used{" "}
                {connected.lastUsedAt ? (
                  <LocalTime iso={connected.lastUsedAt} format="localeString" />
                ) : (
                  "never"
                )}
              </span>
              {/* "I lost the plaintext" recovery — one click revokes the old
                  key + creates a replacement and shows it inline. Same scopes,
                  same name; only the integration's Authorization header has
                  to be updated. */}
              <button
                type="button"
                onClick={rotate}
                disabled={rotating}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-3xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                title="Lost your key? Rotate creates a new one and revokes the old."
              >
                {rotating ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                Rotate key
              </button>
            </div>
          )}

          {revealed && (
            // Sticky reveal: NO dismiss button. The only way to clear this is
            // the explicit "I've saved my key" confirm below. The key is also
            // auto-copied to the clipboard the instant it's generated so a
            // user who navigates away mid-flow still has it on their clipboard
            // (until they copy something else). The pulsing border + warning
            // colour make it unmissable.
            <div className="mt-3 rounded-md border-2 border-amber-500/60 bg-amber-500/5 p-3 shadow-sm">
              <div className="flex items-start gap-2">
                <KeyRound className="mt-0.5 size-4 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                    Save your key now — this is the only time it'll be shown
                  </div>
                  <p className="mt-1 text-2xs text-muted-foreground">
                    Already copied to your clipboard. Paste it into {preset.label}
                    {" "}now. We only store a hash — if you lose it, use{" "}
                    <span className="font-medium">Rotate key</span> to generate
                    a replacement.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="block min-w-0 flex-1 select-all break-all rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs">
                      {revealed}
                    </code>
                    <Button type="button" size="sm" variant="outline" onClick={copyToken}>
                      <Copy className="size-3.5" />
                      Copy
                    </Button>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    onClick={() => setRevealed(null)}
                    className="mt-3"
                  >
                    <CheckCircle2 className="size-3.5" />
                    I&apos;ve saved my key
                  </Button>
                </div>
              </div>
            </div>
          )}

          {!connected && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={generate} disabled={generating}>
                {generating ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <KeyRound className="size-3.5" />
                )}
                Generate API key
              </Button>
              <span className="text-2xs text-muted-foreground">
                Scopes:{" "}
                {preset.recommendedScopes.map((s, i) => (
                  <span key={s}>
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-3xs">
                      {s}
                    </code>
                    {i < preset.recommendedScopes.length - 1 ? " " : ""}
                  </span>
                ))}
              </span>
            </div>
          )}

          {error && <div className="mt-2 text-xs text-destructive">{error}</div>}

          <div className="mt-4 text-xs leading-relaxed text-muted-foreground">
            {instructions}
          </div>

          {preset.curlExamples.length > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                <Terminal className="size-3" />
                Try it from your terminal
              </div>
              {!revealed && (
                <p className="mb-2 text-2xs text-muted-foreground">
                  Replace <code className="rounded bg-muted px-1 py-0.5 font-mono">$CCP_TOKEN</code>{" "}
                  with your key (or{" "}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono">
                    export CCP_TOKEN=ccp_…
                  </code>
                  ).
                </p>
              )}
              <div className="space-y-2">
                {preset.curlExamples.map((ex) => (
                  <CurlBlock
                    key={ex.id}
                    example={ex}
                    origin={origin}
                    token={revealed}
                  />
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
      {confirmDialog}
    </section>
  );
}

function CurlBlock({
  example,
  origin,
  token,
}: {
  example: CurlExample;
  origin: string;
  token: string | null;
}) {
  const command = buildCurl(example, origin, token);
  function copy() {
    void navigator.clipboard.writeText(command).then(
      () => toast.success("curl copied"),
      () => toast.error("Couldn't access clipboard"),
    );
  }
  return (
    <div className="rounded-md border border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-2 text-2xs">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs font-medium uppercase">
            {example.method}
          </span>
          <span className="truncate font-medium text-foreground/90">{example.label}</span>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={copy} className="h-6 px-2">
          <Copy className="size-3" />
          <span className="text-2xs">Copy</span>
        </Button>
      </div>
      <pre className="overflow-x-auto px-2.5 py-2 font-mono text-2xs leading-relaxed text-foreground/90">
        {command}
      </pre>
    </div>
  );
}

function buildCurl(example: CurlExample, origin: string, token: string | null): string {
  // `origin` is empty during the SSR pass — fall back to a relative URL so
  // the rendered HTML still parses; after hydration we re-render with the
  // real host. Token uses the env-var placeholder unless one was just
  // generated (only moment we have the plaintext).
  const url = `${origin}${example.path}`;
  const auth = token ?? "$CCP_TOKEN";
  const lines = [`curl -X ${example.method} '${url}' \\`, `  -H 'Authorization: Bearer ${auth}'`];
  if (example.body) {
    lines[lines.length - 1] += " \\";
    lines.push(`  -H 'Content-Type: application/json' \\`);
    lines.push(`  -d '${JSON.stringify(example.body)}'`);
  }
  return lines.join("\n");
}
