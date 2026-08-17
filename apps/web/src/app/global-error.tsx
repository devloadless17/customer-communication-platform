"use client";

import { useEffect } from "react";

/** One automatic recovery attempt per tab, then we stop and show the page. */
const RECOVER_KEY = "ccp:global-error-reload-at";
const RECOVER_DEBOUNCE_MS = 60_000;

/**
 * A root render error is almost always TRANSIENT — the api restarting during a
 * deploy, or a tab holding a build whose chunks the new deploy deleted. `reset()`
 * cannot fix either: it re-renders the same tree from the same client build, so
 * it re-throws and the tab stays stranded on this page until the user thinks to
 * hard-refresh. A single full reload fixes both, because it re-fetches the
 * document and the current build's assets.
 *
 * Debounced through sessionStorage so a genuinely broken build can't loop: the
 * second failure inside a minute renders this page and leaves it alone.
 */
function recoverOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RECOVER_KEY) ?? 0);
    if (Date.now() - last < RECOVER_DEBOUNCE_MS) return false;
    sessionStorage.setItem(RECOVER_KEY, String(Date.now()));
  } catch {
    // sessionStorage blocked — one reload per page load is an acceptable worst case.
  }
  window.location.reload();
  return true;
}

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  // Next passes `reset` here; deliberately unused — see the Try-again note below.
  reset?: () => void;
}) {
  useEffect(() => {
    console.error("[global-error]", error);
    recoverOnce();
  }, [error]);

  return (
    <html>
      <body className="min-h-svh bg-background text-foreground">
        {/* Mirror next-themes' FOUC script: this standalone document renders its
            own <html>/<body> outside the ThemeProvider, so it would otherwise
            paint light-themed (white flash) for dark-mode users. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");var d=t==="dark"||((!t||t==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d)document.documentElement.classList.add("dark");}catch(e){}})();`,
          }}
        />
        <div className="mx-auto flex min-h-svh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-xl font-semibold">Something broke.</h1>
          <p className="text-sm text-muted-foreground">
            {error.message || "An unexpected error occurred."}
          </p>
          {error.digest ? (
            <p className="font-mono text-2xs text-muted-foreground/70">
              digest: {error.digest}
            </p>
          ) : null}
          {/* A full reload, not `reset()`. reset() re-renders the same tree from
              the same client build, so for the causes that actually land here —
              an api restart mid-deploy, or a stale build's deleted chunks — it
              simply re-throws. `reset` stays in the signature for React. */}
          <button
            onClick={() => window.location.reload()}
            className="mt-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
          <a href="/login" className="text-xs text-muted-foreground underline">
            Go to sign-in
          </a>
        </div>
      </body>
    </html>
  );
}
