"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

/**
 * Shared hook + fallback for auth flows that navigate after a server action.
 *
 * Why the `redirectTo`-returned-from-action + client-side `router.replace`
 * dance instead of calling `redirect("/inbox")` straight from the server
 * action:
 *
 *   1. Better Auth's `nextCookies()` plugin commits the session cookie INTO
 *      the server-action response. Calling `redirect()` in the same action
 *      throws `NEXT_REDIRECT` in the same call, which has produced "An
 *      unexpected response was received from the server." in this codebase
 *      before — fixed by deferring the navigation to the client (see project
 *      memory [first-login-transient-crash] for the incident).
 *
 *   2. A direct redirect to `/` would chain into the RSC redirect at
 *      `app/page.tsx` (`redirect("/inbox")`). Action-response redirect + RSC
 *      redirect = same client-runtime error. Login/register/invite normalize
 *      `/` → `/inbox` before returning to break the chain.
 *
 * Returning a destination string and letting the client navigate after the
 * action resolves keeps both failure modes off the table. The hook handles
 * the navigation; `<AuthRedirectFallback />` renders during the brief gap so
 * the user doesn't see React's reset-uncontrolled-inputs flash.
 */
export interface AuthActionState {
  error: string | null;
  redirectTo?: string;
}

export function useAuthRedirect<S extends AuthActionState>(
  serverAction: (prev: S, fd: FormData) => Promise<S>,
  initial: S,
): {
  state: S;
  action: (formData: FormData) => void;
  isPending: boolean;
  isRedirecting: boolean;
} {
  // useActionState's overload uses `Awaited<S>` for both state + initial. We
  // know S is the resolved state (the action always returns a Promise<S>
  // whose S is not itself a Promise), but TS can't prove that without help —
  // hence the cast on the wrapped action's input.
  const [state, action, isPending] = useActionState<S, FormData>(
    serverAction as (state: Awaited<S>, fd: FormData) => S | Promise<S>,
    initial as Awaited<S>,
  );
  const router = useRouter();

  useEffect(() => {
    if (state.redirectTo) {
      router.replace(state.redirectTo);
    }
  }, [state.redirectTo, router]);

  return {
    state,
    action,
    isPending,
    isRedirecting: Boolean(state.redirectTo),
  };
}

/**
 * Rendered in place of the form during the brief gap between the action
 * resolving and `router.replace` landing. React resets uncontrolled inputs
 * the instant a server action resolves, so without this swap the user would
 * see the cleared fields flash for ~one frame before the navigation.
 */
export function AuthRedirectFallback({
  minHeightClass = "min-h-55",
}: {
  /** Tailwind min-height class; pass the same value the form rendered at
   *  so the panel doesn't jump on the swap. */
  minHeightClass?: string;
}) {
  return (
    <div className={`flex ${minHeightClass} items-center justify-center`}>
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}
