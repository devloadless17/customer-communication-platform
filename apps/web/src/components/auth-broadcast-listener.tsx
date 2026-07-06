"use client";

import { useEffect } from "react";

import { subscribeAuthBroadcast } from "@/lib/auth/auth-broadcast";

/**
 * Mounted once at the root layout. When another tab in the same browser
 * signs out, this tab tears down its socket and hard-navigates to /logout
 * so the cookie is cleared here too — closes the "Tab A logs out, Tab B
 * keeps showing the app" gap.
 *
 * Pathname is read live inside the handler instead of being an effect dep:
 * keeps the subscription stable across navigations (no resubscribe per
 * route change). Pre-auth and teardown routes return early.
 */
export function AuthBroadcastListener(): null {
  useEffect(() => {
    return subscribeAuthBroadcast((msg) => {
      if (msg.type !== "signout") return;
      const p = window.location.pathname;
      if (
        p === "/logout" ||
        p === "/login" ||
        p === "/register" ||
        p.startsWith("/invite/")
      ) {
        return;
      }
      // Lazy-load socket-client so unauthenticated pages (/login, /register,
      // …) — where this handler always early-returns above — don't ship the
      // socket.io-client chunk. Hard-navigate in finally so a failed chunk
      // fetch still logs the tab out.
      import("@/lib/socket-client")
        .then((m) => m.closeClientSocket())
        .finally(() => window.location.replace("/logout"));
    });
  }, []);
  return null;
}
