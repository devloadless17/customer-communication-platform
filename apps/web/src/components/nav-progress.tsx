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
 * The start's state update is deferred to a microtask: `history.pushState`/
 * `replaceState` can be invoked DURING React's commit / insertion-effect phase
 * (inbox `?c=` chat switching, login URL cleanup, team-chat), and calling
 * setState there triggers React 19's "useInsertionEffect must not schedule
 * updates" warning. The hop moves it to a clean tick. Because the hop can race
 * PAST the route commit, two guards keep it order-independent: `applyStart`
 * bails if the target already committed (nothing left to finish, so showing the
 * bar would strand it), and completion only finishes a bar that actually
 * started (`activeRef`) so a skipped start can't flash the bar to 100%.
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
  const activeRef = useRef(false);

  function clearTimers() {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
  }

  useEffect(() => {
    const applyStart = () => {
      // The microtask can race past the route commit. `pushState` set
      // location.pathname to the target synchronously; if the committed React
      // pathname (prevPathRef, updated by the completion effect) already
      // matches it, the nav finished before we ran — so there's no future
      // pathname change to complete the bar. Skip rather than strand it.
      if (window.location.pathname === prevPathRef.current) return;
      activeRef.current = true;
      clearTimers();
      setVisible(true);
      setWidth(8);
      // Ease toward 90% to imply progress while the next route resolves; the
      // final jump to 100% happens on completion below.
      timersRef.current.push(window.setTimeout(() => setWidth(90), 80));
    };
    const start = () => queueMicrotask(applyStart);

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
    // Only finish a bar that actually started — otherwise a start that was
    // skipped (raced past the commit) would still flash the bar to 100%.
    if (!activeRef.current) return;
    activeRef.current = false;
    // New route committed — finish + fade out.
    clearTimers();
    setWidth(100);
    timersRef.current.push(window.setTimeout(() => setVisible(false), 180));
    timersRef.current.push(window.setTimeout(() => setWidth(0), 360));
  }, [pathname]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-100 h-0.5"
      style={{ opacity: visible ? 1 : 0, transition: "opacity 180ms ease" }}
    >
      <div
        className="h-full bg-primary"
        style={{ width: `${width}%`, transition: "width 320ms ease" }}
      />
    </div>
  );
}
