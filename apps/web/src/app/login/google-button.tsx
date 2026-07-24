"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";

import { startGoogleSignIn } from "./google-actions";

/**
 * "Continue with Google".
 *
 * Rendered only when the server says an OAuth client is configured — a button
 * that starts a handshake nobody can finish is worse than no button at all, so
 * the decision is made server-side (`googleSignInEnabled()`) and passed down.
 *
 * Serves BOTH sign-in and sign-up: Google is the same handshake either way, and
 * the org is provisioned on first arrival (see the database hook in
 * `lib/auth/better-auth.ts`). Presenting it as two different buttons would
 * imply a choice the user doesn't have to make.
 */
export function GoogleButton({ next, label }: { next: string; label: string }) {
  return (
    <form action={startGoogleSignIn}>
      <input type="hidden" name="next" value={next} />
      <SubmitButton label={label} />
    </form>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-md border bg-background text-sm font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? (
        <Loader2 aria-hidden className="size-4 animate-spin" />
      ) : (
        <GoogleMark />
      )}
      {pending ? "Redirecting…" : label}
    </button>
  );
}

/** Google's mark, inline. An external image would be blocked by our CSP and
 *  leaves a broken icon; the paths are the official four-colour glyph. */
function GoogleMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.8l4-3.1z"
      />
      <path
        fill="#EA4335"
        d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8z"
      />
    </svg>
  );
}
