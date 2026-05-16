"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

const COOKIE_NAME = "tz";

interface TzContextValue {
  /** IANA zone the server used for this render (e.g., "Asia/Beirut"). */
  tz: string;
  /** Wall-clock "now" used for relative-time buckets. Starts at server-render
   *  time so SSR and the first client paint produce identical strings; ticks
   *  every 60s so "12m" rolls forward without a refresh. */
  now: number;
}

const TzContext = createContext<TzContextValue>({ tz: "UTC", now: 0 });

export function useTimezone(): string {
  return useContext(TzContext).tz;
}

export function useTzNow(): TzContextValue {
  return useContext(TzContext);
}

/**
 * Bridges the server-detected timezone (read from the `tz` cookie) into the
 * client tree, and syncs the cookie when the browser's actual zone differs.
 *
 * On first ever visit the cookie is missing — server renders in UTC, the
 * effect below detects the real zone, writes the cookie, and triggers a
 * router refresh so the next paint uses it. Every subsequent navigation
 * is instant-correct because the server already knows the zone.
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
  const router = useRouter();

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
    router.refresh();
  }, [tz, router]);

  const value = useMemo(() => ({ tz, now }), [tz, now]);
  return <TzContext.Provider value={value}>{children}</TzContext.Provider>;
}
