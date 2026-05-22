"use client";

import {
  formatListTime,
  formatLocaleDate,
  formatLocaleString,
  formatMessageTime,
  formatShortDate,
} from "@ccp/shared/utils";

import { useTimezone, useTzNow } from "@/providers/tz-provider";

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
 *
 * Re-render cost: most formats render an ABSOLUTE timestamp that doesn't
 * depend on the clock, so they subscribe only to the stable tz context and
 * never re-render on the 60s `now` tick. Only `listTime` is relative ("12m")
 * and needs live `now` — it's isolated in `LiveRelativeTime` so the tick
 * re-renders just those spans, not every <LocalTime> in every list row.
 */
const FORMATTERS = {
  listTime: formatListTime,
  messageTime: formatMessageTime,
  localeDate: formatLocaleDate,
  localeString: formatLocaleString,
  shortDate: formatShortDate,
} as const;

export type LocalTimeFormat = keyof typeof FORMATTERS;

/** The only registry entries that actually consume `now` (relative buckets).
 *  Keep in sync with the formatter signatures in @ccp/shared/utils. */
const RELATIVE_FORMATS: ReadonlySet<LocalTimeFormat> = new Set(["listTime"]);

export function LocalTime(props: {
  iso: string | Date | null | undefined;
  format: LocalTimeFormat;
  className?: string;
}) {
  // Route to the right subscriber: absolute timestamps read only the stable
  // tz context (never re-render on the 60s tick); relative spans read the
  // ticking clock. `format` is fixed per instance, so this conditional
  // render is rules-of-hooks-safe (each branch component calls its own hooks
  // unconditionally).
  return RELATIVE_FORMATS.has(props.format) ? (
    <RelativeTime {...props} />
  ) : (
    <AbsoluteTime {...props} />
  );
}

/** Absolute timestamps — independent of the wall clock, so subscribe to the
 *  stable tz context only and skip the 60s tick entirely. */
function AbsoluteTime({
  iso,
  format,
  className,
}: {
  iso: string | Date | null | undefined;
  format: LocalTimeFormat;
  className?: string;
}) {
  const tz = useTimezone();
  if (iso == null) return <span className={className} />;
  const s = iso instanceof Date ? iso.toISOString() : iso;
  return <span className={className}>{FORMATTERS[format](s, tz)}</span>;
}

/** Relative-time spans ("12m") that must roll forward — subscribes to the
 *  ticking `now` via useTzNow, so it re-renders every 60s. */
function RelativeTime({
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
