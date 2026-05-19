"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Copy, KeyRound, Loader2, Terminal, Zap } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
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
  const [error, setError] = useState<string | null>(null);
  // Filled in after mount — `window` isn't available during the SSR pass,
  // and we want the curls to use the user's actual host (works against
  // localhost, staging, and prod without per-env overrides).
  const [origin, setOrigin] = useState<string>("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  async function generate() {
    setError(null);
    setGenerating(true);
    try {
      const res = await fetch("/api/team/api-keys", {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "network error");
    } finally {
      setGenerating(false);
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
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-600">
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
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
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
            </div>
          )}

          {revealed && (
            <div className="mt-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 p-3">
              <div className="flex items-start gap-2">
                <KeyRound className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium">Copy your key now</div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    Paste it into {preset.label}. This is the only time the
                    full token will be displayed — we store only a hash.
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="block min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs">
                      {revealed}
                    </code>
                    <Button type="button" size="sm" variant="outline" onClick={copyToken}>
                      <Copy className="size-3.5" />
                      Copy
                    </Button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setRevealed(null)}
                    className="mt-2 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                  >
                    Dismiss
                  </button>
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
              <span className="text-[11px] text-muted-foreground">
                Scopes:{" "}
                {preset.recommendedScopes.map((s, i) => (
                  <span key={s}>
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
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
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <Terminal className="size-3" />
                Try it from your terminal
              </div>
              {!revealed && (
                <p className="mb-2 text-[11px] text-muted-foreground">
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

          {connected && (
            <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px]">
              <Link
                href="/settings/api-keys"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Rotate or revoke <ArrowRight className="size-3" />
              </Link>
            </div>
          )}
        </div>
      </div>
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
        <div className="flex min-w-0 items-center gap-2 text-[11px]">
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase">
            {example.method}
          </span>
          <span className="truncate font-medium text-foreground/90">{example.label}</span>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={copy} className="h-6 px-2">
          <Copy className="size-3" />
          <span className="text-[11px]">Copy</span>
        </Button>
      </div>
      <pre className="overflow-x-auto px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/90">
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
