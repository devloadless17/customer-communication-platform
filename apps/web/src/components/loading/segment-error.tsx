"use client";

import { useEffect, useState } from "react";

import { isChunkLoadError, reloadForStaleChunk } from "@/lib/chunk-error";

/**
 * Shared per-segment error boundary. Mirrors the existing inbox/error.tsx
 * shape so the visuals stay consistent across segments without each one
 * re-implementing the same chrome.
 *
 * Per-segment boundaries (instead of relying only on global-error.tsx)
 * keep the nav chrome alive when one segment throws — the user can
 * navigate away without a full page reload.
 *
 * Chunk-load self-heal: when a `next/dynamic` chunk fails (stale hash after a
 * deploy / dev hot-reload), the failure is caught HERE during render, before
 * it can reach window — so ChunkErrorReload never sees it. We detect that case
 * and hard-reload once (debounced) instead of showing the manual error screen.
 * This is exactly the "Inbox failed to load. Failed to load chunk …template-
 * picker…" the user reported. If the reload is debounced (we already tried
 * recently → bundle genuinely broken), we fall through to the manual UI.
 */
export function SegmentError({
  error,
  reset,
  segmentLabel,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Human-friendly section name, e.g. "Team chat", "Workflows", etc. */
  segmentLabel: string;
}) {
  // Start in "reloading" if this is a fresh chunk error so we don't flash the
  // manual screen before the reload kicks in. The effect below confirms +
  // triggers the actual reload (effects only run client-side).
  const [reloading, setReloading] = useState(() => isChunkLoadError(error));

  useEffect(() => {
    console.error(`[${segmentLabel.toLowerCase().replace(/\s+/g, "-")}-error]`, error);
    if (isChunkLoadError(error)) {
      // reloadForStaleChunk returns false when debounced — then show the
      // manual screen rather than sitting on a blank "reloading" forever.
      const triggered = reloadForStaleChunk();
      if (!triggered) setReloading(false);
    }
  }, [error, segmentLabel]);

  // Brief blank while window.location.reload() takes effect — avoids a flash of
  // the error chrome on the common, self-healing stale-chunk case.
  if (reloading) {
    return <div className="min-h-svh bg-background" aria-hidden />;
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-6 text-center">
      <div className="flex max-w-md flex-col items-center gap-3">
        <h2 className="text-base font-semibold">{segmentLabel} failed to load.</h2>
        <p className="text-sm text-muted-foreground">
          {error.message || "Unknown error."}
        </p>
        {error.digest ? (
          <p className="font-mono text-[11px] text-muted-foreground/70">
            digest: {error.digest}
          </p>
        ) : null}
        <div className="mt-2 flex gap-2">
          <button
            onClick={reset}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
          <a
            href="/inbox"
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            Back to inbox
          </a>
        </div>
      </div>
    </div>
  );
}
