"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const COOKIE_NAME = "tz";

interface TzContextValue {
  /** IANA zone the server used for this render (e.g., "Asia/Beirut"). */
  tz: string;
  /** Wall-clock "now" used for relative-time buckets. Starts at server-render
   *  time so SSR and the first client paint produce identical strings; ticks
   *  every 60s so "12m" rolls forward without a refresh. */
  now: number;
}

// Two SEPARATE contexts on purpose. `tz` is effectively immutable for a
// session; `now` ticks every 60s. If both lived on one context value, the
// 60s tick would re-render EVERY consumer — and because context bypasses
// React.memo, that means every <LocalTime> in every list row (worst on the
// contacts directory) re-rendering on a minute heartbeat. Splitting them
// lets absolute-timestamp consumers subscribe to the stable TzContext only
// and never re-render on the tick; only live relative-time consumers
// subscribe to NowContext. See LocalTime for how the split is applied.
const TzContext = createContext<string>("UTC");
const NowContext = createContext<number>(0);

/** Stable IANA zone — never changes on the 60s tick. Subscribe to this from
 *  anything rendering an ABSOLUTE timestamp so the tick can't re-render it. */
export function useTimezone(): string {
  return useContext(TzContext);
}

/** tz + the ticking wall-clock "now" (ms). Subscribes to NowContext, so a
 *  consumer re-renders every 60s — only use it where live relative time is
 *  needed ("12m ago", the thread's day separators). For absolute timestamps
 *  use `useTimezone()` instead. */
export function useTzNow(): TzContextValue {
  return { tz: useContext(TzContext), now: useContext(NowContext) };
}

/**
 * Bridges the server-detected timezone (read from the `tz` cookie) into the
 * client tree, and syncs the cookie when the browser's actual zone differs.
 *
 * On first ever visit the cookie is missing — server renders with the
 * default zone (`Asia/Beirut`, see lib/server-tz.ts). The effect below
 * detects the real zone and writes the cookie so subsequent navigations
 * render with the correct zone. The first page itself stays in the default
 * zone for that single render — we used to call `router.refresh()` to fix
 * that, but the refresh races with auth flows (the proxy can re-evaluate
 * the cookie gate while sign-in / sign-up is mid-flight, producing
 * confusing transient states). One-off off-by-one for first-ever visitors
 * is the cheaper tradeoff.
 */
export function TimezoneProvider({
  tz,
  serverNow,
  children,
}: {
  tz: string;
  serverNow: number;
  children: ReactNode;
}) {
  // Initial state = serverNow so SSR and first client render compute the
  // same relative-time buckets. The effect re-syncs to the actual client
  // clock (within ~milliseconds, usually a no-op visually) and then ticks
  // every minute for live "Xm ago" updates.
  const [now, setNow] = useState<number>(serverNow);
  useEffect(() => {
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!detected || detected === tz) return;
    document.cookie =
      `${COOKIE_NAME}=${encodeURIComponent(detected)}; path=/; max-age=31536000; samesite=lax`;
    // No router.refresh() — see the comment block at the top of this
    // function for why. The cookie is in place; the next navigation
    // picks it up.
  }, [tz]);

  // `tz` rides its own provider so the 60s `now` tick can't re-render the
  // (large) set of absolute-timestamp consumers. `now` is a bare number, so
  // its provider re-renders only the few live-relative-time subscribers.
  return (
    <TzContext.Provider value={tz}>
      <NowContext.Provider value={now}>{children}</NowContext.Provider>
    </TzContext.Provider>
  );
}
