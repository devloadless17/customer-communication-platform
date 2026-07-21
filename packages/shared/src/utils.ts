import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Phone formatting lives in ./utils/phone so libphonenumber-js/min (~37KB gz)
// stays OUT of this barrel's own module graph — `cn`/`initials`-only consumers
// tree-shake it away (sideEffects:false), and phone-formatting consumers should
// import from "@ccp/shared/utils/phone" directly. Re-exported here for existing
// "@ccp/shared/utils" importers.
export {
  formatPhone,
  getCountryFromPhone,
  formatContactIdentity,
} from "./utils/phone";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  // First CODE POINT of a word (not `w[0]`) + letters/numbers only, so an
  // emoji-led name (common as WhatsApp push names, e.g. "🌸 Sara") doesn't
  // render a broken half-surrogate. Mirrors contact-composer.tsx's local copy
  // — that duplicate should be deleted in favour of this shared version.
  const glyph = (w: string | undefined) => {
    const ch = w ? Array.from(w)[0] ?? "" : "";
    return /\p{L}|\p{N}/u.test(ch) ? ch : "";
  };
  const first = glyph(parts[0]);
  const last = parts.length > 1 ? glyph(parts[parts.length - 1]) : "";
  return (first + last).toUpperCase() || "?";
}

// All time formatters take `(iso, tz?, now?)`:
//   - `tz` is an IANA timezone passed through to Intl. Server reads this
//     from the `tz` cookie via getServerTimezone(); client reads it from
//     TimezoneProvider's context. Same value on both sides → identical
//     strings on SSR + first paint, so no UTC flash and no hydration warning.
//   - `now` is wall-clock ms used for relative buckets. Provided by the
//     same context (initialised to the server's render time and ticked
//     every 60s on the client).
// `tz` undefined means "use the runtime default zone" — only happens in
// raw test/script contexts; in-app calls always go through <LocalTime>.

/**
 * `Intl.DateTimeFormat` constructor is the expensive part of locale
 * formatting; `formatToParts` itself is cheap. Cache one formatter per tz
 * so a 500-message thread's day-separator memo doesn't construct 1000
 * formatters per re-memo (each `formatDaySeparator` call hits this twice
 * — once for `now`, once for the message). At 10 inbound/sec rendering
 * 30-min worth of bubbles, that's ~hundreds of MS of pure formatter
 * construction per re-render saved. Tiny memory footprint (one formatter
 * per active tz, typically 1-3 per process).
 */
const calendarDayFormatters = new Map<string, Intl.DateTimeFormat>();
function calendarDay(d: Date, tz?: string): { y: number; m: number; d: number } {
  const key = tz ?? "";
  let fmt = calendarDayFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    calendarDayFormatters.set(key, fmt);
  }
  const parts = fmt.formatToParts(d);
  return {
    y: Number(parts.find((p) => p.type === "year")?.value),
    m: Number(parts.find((p) => p.type === "month")?.value),
    d: Number(parts.find((p) => p.type === "day")?.value),
  };
}

/**
 * Stable YYYY-MM-DD-shape calendar-day key for a given instant + tz.
 * Backed by the SAME formatter cache the day-separator uses — call sites
 * (e.g. message-thread's `todayKey` memo) MUST go through this helper
 * instead of `new Intl.DateTimeFormat("en-CA", { timeZone: tz })` so the
 * 60s `now` tick doesn't allocate a fresh formatter every minute.
 *
 * "en-CA" gives `YYYY-MM-DD`; we wrap with try/catch the same way
 * formatDaySeparator does so a bad tz tag doesn't throw mid-render.
 */
const enCaDayFormatters = new Map<string, Intl.DateTimeFormat>();
export function calendarDayKey(now: number | Date, tz?: string): string {
  const key = tz ?? "";
  let fmt = enCaDayFormatters.get(key);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    } catch {
      fmt = new Intl.DateTimeFormat("en-CA");
    }
    enCaDayFormatters.set(key, fmt);
  }
  return fmt.format(typeof now === "number" ? new Date(now) : now);
}

/**
 * Cached `en-US` formatter, keyed by `format-id + tz`. `Date.prototype.to-
 * Locale*` constructs a fresh `Intl.DateTimeFormat` on EVERY call — the exact
 * cost the calendarDay caches above avoid. The per-message-bubble + per-list-
 * row formatters below render once per visible row (hundreds on a cold thread
 * open), so they MUST reuse a formatter, not allocate one per row. Same
 * try/catch-on-bad-tz posture as calendarDayKey. One formatter per (format, tz)
 * — a handful per process.
 */
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(id: string, tz: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${id}|${tz ?? ""}`;
  let f = dtfCache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz });
    } catch {
      f = new Intl.DateTimeFormat("en-US", opts);
    }
    dtfCache.set(key, f);
  }
  return f;
}

/** Compact relative time used in the conversation list ("now", "12m", "3h", "Mon", "Mar 4"). */
export function formatListTime(iso: string, tz?: string, now?: number): string {
  const then = new Date(iso);
  const nowMs = now ?? Date.now();
  const diffSec = Math.round((then.getTime() - nowMs) / 1000);
  const abs = Math.abs(diffSec);

  if (abs < 60) return "now";
  if (abs < 3600) return `${Math.round(abs / 60)}m`;
  if (abs < 86400) return `${Math.round(abs / 3600)}h`;
  if (abs < 86400 * 7) {
    return dtf("wd", tz, { weekday: "short" }).format(then);
  }
  return dtf("md", tz, { month: "short", day: "numeric" }).format(then);
}

/** Time stamp inside the message thread. */
export function formatMessageTime(iso: string, tz?: string): string {
  return dtf("t", tz, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** Locale-formatted "YYYY-MM-DD, HH:MM:SS AM/PM" for log/admin views. */
export function formatLocaleString(iso: string, tz?: string): string {
  return new Date(iso).toLocaleString(undefined, { timeZone: tz });
}

/** Locale-formatted short date, e.g. "5/14/2026". */
export function formatLocaleDate(iso: string, tz?: string): string {
  return new Date(iso).toLocaleDateString(undefined, { timeZone: tz });
}

/** Long-form short date with year, e.g. "Mar 4, 2026". Used by the contact panel. */
export function formatShortDate(iso: string, tz?: string): string {
  return dtf("sd", tz, { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}

/** Day separator label used between message clusters. */
export function formatDaySeparator(iso: string, tz?: string, now?: number): string {
  const then = new Date(iso);
  const a = calendarDay(now != null ? new Date(now) : new Date(), tz);
  const b = calendarDay(then, tz);
  const aDate = new Date(a.y, a.m - 1, a.d);
  const bDate = new Date(b.y, b.m - 1, b.d);
  const diffDays = Math.round((aDate.getTime() - bDate.getTime()) / 86400000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return then.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
  return then.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });
}
