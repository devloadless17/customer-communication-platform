"use client";

import { useEffect, useState } from "react";

/**
 * One process-wide 60-second tick. Every consumer in the tree (`WindowBadge`,
 * `ReplyBox`, eventually anything that needs "now"-ish for the 24h
 * customer-service window) reads from this so we don't have N parallel
 * intervals each scheduling their own re-render. Subtle but real perf win
 * on busy inboxes — and removes the SSR/client `Date.now()` mismatch since
 * the initial value is null until after mount.
 *
 * Default tick is 60s. Pass a smaller value if a component needs a faster
 * cadence; the shared interval still ticks at 60s but consumers can pull a
 * fresh value on render between ticks.
 */
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let cachedNow: number | null = null;

function ensureTimer(): void {
  if (timer !== null) return;
  cachedNow = Date.now();
  timer = setInterval(() => {
    cachedNow = Date.now();
    subscribers.forEach((notify) => notify());
  }, 60_000);
}

function teardownIfIdle(): void {
  if (subscribers.size > 0 || timer === null) return;
  clearInterval(timer);
  timer = null;
  cachedNow = null;
}

/**
 * Returns a `Date.now()` value that updates every 60s, shared across all
 * consumers. SSR-safe: returns `null` until after mount so server and client
 * first renders agree, then resyncs via useEffect.
 */
export function useNow(): number | null {
  const [, force] = useState(0);

  useEffect(() => {
    ensureTimer();
    const notify = () => force((n) => n + 1);
    subscribers.add(notify);
    // Sync once on mount so the first render after hydration has the live
    // value instead of waiting up to 60s for the next tick.
    force((n) => n + 1);
    return () => {
      subscribers.delete(notify);
      teardownIfIdle();
    };
  }, []);

  return cachedNow;
}
