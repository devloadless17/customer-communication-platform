"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global-error]", error);
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
          <button
            onClick={reset}
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
