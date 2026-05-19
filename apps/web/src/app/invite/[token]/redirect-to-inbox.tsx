"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

/**
 * Rendered by the invite page when an invite is already accepted AND the
 * current visitor is signed in as that invite's email — i.e. the user who
 * just submitted the accept form.
 *
 * Why we need this: every server action triggers a route refresh of the
 * page it was called from. After acceptance, that refresh re-renders
 * page.tsx with `invite.acceptedAt` now set, which unmounts the AcceptForm
 * BEFORE its `useEffect` can fire `router.replace("/inbox")`. So the
 * just-accepted user gets stranded on the "Already accepted" Shell. This
 * component does the navigation in a fresh subtree that survives that
 * refresh.
 *
 * Client-side (not `redirect("/inbox")` server-side) for the same reason
 * the action returns `redirectTo` instead of calling redirect(): the
 * Better Auth nextCookies plugin commits the session cookie into the
 * server-action response, and chaining an RSC redirect into that response
 * has produced "An unexpected response was received from the server" in
 * this codebase before (see project memory: first-login-transient-crash).
 */
export function RedirectToInbox() {
  const router = useRouter();
  useEffect(() => {
    // Prefetch first, then replace. AcceptForm already prefetched /inbox
    // when it mounted, so this is usually a no-op cache hit — but if the
    // browser navigated directly into the "Already accepted" Shell (e.g.
    // the user followed the link in a second tab AFTER accepting in the
    // first), the form never mounted and this is the first chance to
    // warm the cache. Belt + suspenders so the redirect lands instantly
    // in both code paths.
    router.prefetch("/inbox");
    router.replace("/inbox");
  }, [router]);

  return (
    <div className="grid min-h-svh place-items-center bg-background px-4">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  );
}
