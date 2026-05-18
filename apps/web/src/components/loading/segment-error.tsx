"use client";

import { useEffect } from "react";

/**
 * Shared per-segment error boundary. Mirrors the existing inbox/error.tsx
 * shape so the visuals stay consistent across segments without each one
 * re-implementing the same chrome.
 *
 * Per-segment boundaries (instead of relying only on global-error.tsx)
 * keep the nav chrome alive when one segment throws — the user can
 * navigate away without a full page reload.
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
  useEffect(() => {
    console.error(`[${segmentLabel.toLowerCase().replace(/\s+/g, "-")}-error]`, error);
  }, [error, segmentLabel]);

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
