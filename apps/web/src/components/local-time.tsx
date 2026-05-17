"use client";

import {
  formatListTime,
  formatLocaleDate,
  formatLocaleString,
  formatMessageTime,
  formatShortDate,
} from "@ccp/shared/utils";

import { useTzNow } from "@/providers/tz-provider";

/**
 * Renders `format(iso, tz, now)` synchronously. Server and client both pull
 * `tz` + `now` from TimezoneProvider — the same values — so the rendered
 * string is identical on both sides. That eliminates the post-hydration
 * flicker the previous useEffect-based version had.
 *
 * `format` is a string key into the registry below — NOT a function reference.
 * Server Components can't pass functions across the RSC boundary (they aren't
 * serializable into the Flight payload), so anything that needs to render
 * timestamps from RSC has to name its formatter, not point at it. Client
 * callers use the same string key for consistency.
 *
 * To add a new format: write the function in `@ccp/shared/utils` and add a
 * single line to FORMATTERS below. Don't reintroduce a function-prop overload
 * — it makes the same bug too easy to write.
 */
const FORMATTERS = {
  listTime: formatListTime,
  messageTime: formatMessageTime,
  localeDate: formatLocaleDate,
  localeString: formatLocaleString,
  shortDate: formatShortDate,
} as const;

export type LocalTimeFormat = keyof typeof FORMATTERS;

export function LocalTime({
  iso,
  format,
  className,
}: {
  iso: string | Date | null | undefined;
  format: LocalTimeFormat;
  className?: string;
}) {
  const { tz, now } = useTzNow();
  if (iso == null) return <span className={className} />;
  const s = iso instanceof Date ? iso.toISOString() : iso;
  return <span className={className}>{FORMATTERS[format](s, tz, now)}</span>;
}
