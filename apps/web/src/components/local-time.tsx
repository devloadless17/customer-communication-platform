"use client";

import { useTzNow } from "@/providers/tz-provider";

/**
 * Renders `format(iso, tz, now)` synchronously. Server and client both pull
 * `tz` + `now` from TimezoneProvider — the same values — so the rendered
 * string is identical on both sides. That eliminates the post-hydration
 * flicker the previous useEffect-based version had.
 *
 * `format` must be a stable module-level reference (e.g., the exports in
 * `lib/utils.ts`). Functions can opt into either arg by accepting them in
 * their signature; those that don't simply ignore them.
 */
export function LocalTime({
  iso,
  format,
  className,
}: {
  iso: string | Date | null | undefined;
  format: (iso: string, tz?: string, now?: number) => string;
  className?: string;
}) {
  const { tz, now } = useTzNow();
  if (iso == null) return <span className={className} />;
  const s = iso instanceof Date ? iso.toISOString() : iso;
  return <span className={className}>{format(s, tz, now)}</span>;
}
