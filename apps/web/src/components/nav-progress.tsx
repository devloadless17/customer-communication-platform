"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * App-wide navigation progress bar (GitHub / Linear style). Pairs with removing
 * the per-route `loading.tsx` skeletons: with those gone, React holds the
 * CURRENT page on screen during a client navigation until the next route is
 * ready, and this thin top bar is the "something is happening" feedback — so a
 * section switch feels like the content updates in place, not a teardown →
 * skeleton → rebuild flash.
 *
 * Start is detected by wrapping `history.pushState`/`replaceState` (Next's App
 * Router router drives client navigations through them) plus `popstate` for
 * back/forward. We only start when the target PATHNAME differs, so same-path
 * query updates (e.g. the inbox's `?c=` chat switching) don't flash the bar.
 * Completion fires when `usePathname()` reports the new route has committed.
 *
 * Fully isolated: a `pointer-events-none` fixed overlay that only animates
 * width/opacity. Worst case it doesn't show — it can't affect page content or
 * block navigation (the history wrappers always call the original).
 */
export function NavProgress() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const timersRef = useRef<number[]>([]);
  const prevPathRef = useRef(pathname);

  function clearTimers() {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
  }

  useEffect(() => {
    const start = () => {
      clearTimers();
      setVisible(true);
      setWidth(8);
      // Ease toward 90% to imply progress while the next route resolves; the
      // final jump to 100% happens on completion below.
      timersRef.current.push(window.setTimeout(() => setWidth(90), 80));
    };

    const wrap =
      (orig: History["pushState"]) =>
      function (this: History, ...args: Parameters<History["pushState"]>) {
        const url = args[2];
        try {
          if (url != null) {
            const nextPath = new URL(String(url), window.location.href).pathname;
            if (nextPath !== window.location.pathname) start();
          }
        } catch {
          /* malformed URL — skip the bar, never break navigation */
        }
        return orig.apply(this, args);
      };

    const origPush = window.history.pushState;
    const origReplace = window.history.replaceState;
    window.history.pushState = wrap(origPush);
    window.history.replaceState = wrap(origReplace);
    window.addEventListener("popstate", start);

    return () => {
      window.history.pushState = origPush;
      window.history.replaceState = origReplace;
      window.removeEventListener("popstate", start);
      clearTimers();
    };
  }, []);

  useEffect(() => {
    if (pathname === prevPathRef.current) return;
    prevPathRef.current = pathname;
    // New route committed — finish + fade out.
    clearTimers();
    setWidth(100);
    timersRef.current.push(window.setTimeout(() => setVisible(false), 180));
    timersRef.current.push(window.setTimeout(() => setWidth(0), 360));
  }, [pathname]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 180ms ease" }}
    >
      <div
        className="h-full bg-primary"
        style={{ width: `${width}%`, transition: "width 320ms ease" }}
      />
    </div>
  );
}
