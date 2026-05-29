"use client";

import { useTzNow } from "@/providers/tz-provider";

/**
 * Shared "now" used by relative-time UI (24h-window badge, etc.). Re-exports
 * `TimezoneProvider`'s ticking clock — initialized to the server's `Date.now()`
 * on first render so SSR and the first client paint produce identical strings
 * (no "Window closed" → "Window closed · 8h left" flash on refresh).
 *
 * Ticks every 60s via the provider's interval. Consumers that don't need the
 * live tick should read absolute times via `useTimezone()` instead so the
 * minute heartbeat doesn't re-render them.
 *
 * Returns a non-null number. The old null-then-fill posture was the actual
 * source of the split-paint flicker the rest of the file was working around
 * with `hideRemaining` / `?? Date.now()` fallbacks — removed throughout.
 */
export function useNow(): number {
  return useTzNow().now;
}
