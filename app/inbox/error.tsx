"use client";

import { useEffect } from "react";

export default function InboxError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[inbox-error]", error);
  }, [error]);

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-6 text-center">
      <div className="flex max-w-md flex-col items-center gap-3">
        <h2 className="text-base font-semibold">The inbox failed to load.</h2>
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
            href="/logout"
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            Sign out
          </a>
        </div>
      </div>
    </div>
  );
}
