"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { broadcastSignout } from "@/lib/auth/auth-broadcast";
import { closeClientSocket } from "@/lib/socket-client";

/**
 * Full-screen "Signing out…" overlay. Masks the browser's blank-page
 * window between `window.location.assign("/logout")` and `/login`
 * actually rendering — without this, the user clicks Sign out and sees
 * a few hundred ms of nothing (cookies-clearing redirect chain) before
 * the login page appears, which feels broken.
 *
 * Logout MUST stay a hard navigation (see app-rail.tsx for the cookie-
 * race history). The overlay is the polish layer: render it FIRST, give
 * React one frame to paint, then trigger the hard nav so the overlay is
 * the last thing visible until the browser swaps the whole document.
 *
 * Usage:
 *   const { trigger, overlay } = useSignOutOverlay();
 *   return <>
 *     <button onClick={trigger}>Sign out</button>
 *     {overlay}
 *   </>;
 */
export function useSignOutOverlay(): {
  trigger: () => void;
  overlay: React.ReactNode;
} {
  const [signingOut, setSigningOut] = useState(false);

  const trigger = () => {
    if (signingOut) return;
    setSigningOut(true);
    // Cross-tab signal + socket teardown happen first so other tabs and
    // the server presence ring update immediately. Then the overlay
    // gets one frame to paint, THEN the hard navigation kicks in.
    broadcastSignout();
    closeClientSocket();
    // requestAnimationFrame ensures the overlay's first paint lands
    // before the browser starts the unload. Without this, on fast
    // machines the navigation can pre-empt the paint and the user
    // still sees a blank screen.
    requestAnimationFrame(() => {
      window.location.assign("/logout");
    });
  };

  const overlay = signingOut ? (
    <div
      role="status"
      aria-live="polite"
      aria-label="Signing out"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background"
    >
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <p className="text-sm font-medium text-muted-foreground">Signing out…</p>
      </div>
    </div>
  ) : null;

  return { trigger, overlay };
}
