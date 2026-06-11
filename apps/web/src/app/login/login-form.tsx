"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { broadcastSignout } from "@/lib/auth/auth-broadcast";

import { loginAction, type LoginState } from "./actions";

const INITIAL: LoginState = { error: null };

/**
 * No client-side spinner card. The server action calls
 * `redirect()` directly after committing the session cookie — the browser
 * receives both in the same response and navigates immediately. The user
 * sees the button switch to "Signing in…" and then the destination page,
 * with no "form-disappears-into-spinner-then-page-appears" intermediate
 * frame the earlier `AuthRedirectFallback` produced.
 */
export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [state, action] = useActionState(loginAction, INITIAL);

  // Prefetch the post-login destination so the navigation that the server-
  // side redirect triggers paints near-instantly. Even with `redirect()`
  // the browser still fetches the destination's RSC payload before paint;
  // prefetching makes that step a cache hit.
  useEffect(() => {
    router.prefetch(next);
  }, [router, next]);

  // Server-initiated /logout sets `?bc=1` on the redirect to /login.
  // Forward that signal to sibling tabs that didn't initiate the signout
  // (email "sign out" links, 401 → /logout chains). Rail-button signouts
  // already broadcast before navigating; this catches the rest. Strip the
  // flag from the URL so a back-forward navigation doesn't re-broadcast.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("bc") !== "1") return;
    broadcastSignout();
    url.searchParams.delete("bc");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />

      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-xs font-medium text-foreground">
          Email
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          placeholder="you@company.com"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor="password" className="text-xs font-medium text-foreground">
            Password
          </label>
          {/* No self-serve reset (no email provider by design) — recovery is
              admin-initiated. Point users at the right person instead of a
              dead "Forgot password?" link. */}
          <span className="text-[11px] text-muted-foreground">
            Forgot it? Ask your admin to reset it.
          </span>
        </div>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="••••••••"
        />
      </div>

      {state.error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {state.error}
        </div>
      )}

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="mt-2 w-full" disabled={pending}>
      {pending ? (
        <>
          <Loader2 className="size-4 animate-spin" />
          Signing in…
        </>
      ) : (
        "Sign in"
      )}
    </Button>
  );
}
