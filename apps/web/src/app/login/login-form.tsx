"use client";

import { useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AuthRedirectFallback,
  useAuthRedirect,
} from "@/hooks/use-auth-redirect";
import { broadcastSignout } from "@/lib/auth/auth-broadcast";

import { loginAction, type LoginState } from "./actions";

const INITIAL: LoginState = { error: null };

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const { state, action, isRedirecting } = useAuthRedirect(loginAction, INITIAL);

  // Prefetch the post-login destination as soon as the form mounts. Without
  // this, the user clicks Sign in → action runs (~150ms) → state.redirectTo
  // set → router.replace → /inbox starts SSR + 3 catalog fetches → finally
  // /inbox paints. The intermediate `AuthRedirectFallback` is the spinner
  // the user perceives as "the form flickering then loading". Prefetching
  // the destination here warms Next.js's RSC cache so the post-action
  // navigation is near-instant.
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

  if (isRedirecting) {
    return <AuthRedirectFallback minHeightClass="min-h-55" />;
  }

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
        <label htmlFor="password" className="text-xs font-medium text-foreground">
          Password
        </label>
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
