"use client";

import { useEffect } from "react";

/**
 * One-shot service-worker unregister kill switch.
 *
 * This app does NOT ship a service worker. But `localhost:3000` (or whatever
 * origin a deploy lives on) can have a SW registered by a *prior* app on the
 * same origin — the SW persists per-origin in the browser across server
 * restarts, code rewrites, even browser restarts. Symptom: page keeps
 * refreshing / serving stale HTML even when the server is down.
 *
 * Run unregister() on every page load. On clean clients it's a no-op
 * (getRegistrations() returns []); on clients with a ghost SW it purges it
 * within milliseconds and the next reload runs against the live server.
 *
 * Why a client component instead of an inline `<script nonce={...}>` in the
 * root layout: browsers strip the `nonce` attribute from the serialized DOM
 * (CSP3 rule — nonce is readable via `el.nonce` JS prop only, NOT via
 * `getAttribute` or `outerHTML`). React's hydration reads the DOM, sees
 * nonce="", and warns about a mismatch with the SSR payload. A client
 * useEffect avoids the inline-script-with-nonce path entirely.
 *
 * Safe to delete a few weeks after deploy — every active browser will have
 * run this at least once by then.
 */
export function ServiceWorkerKillSwitch() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => {
        for (const r of regs) {
          void r.unregister();
        }
      })
      .catch(() => {
        // No-op — getRegistrations rejects on some privacy-hardened
        // browsers / private windows. Nothing to do; the user just won't
        // benefit from auto-cleanup. Manual DevTools → Application →
        // Unregister still works.
      });
  }, []);
  return null;
}
