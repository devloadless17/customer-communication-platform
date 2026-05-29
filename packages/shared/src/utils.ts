import { clsx, type ClassValue } from "clsx";
// `/min` ships the smallest country-metadata bundle libphonenumber supports
// (~70% smaller than the default `/max`). All we use it for is
// `formatInternational()` on E.164 numbers we already trust — the trimmed
// metadata is plenty for that, and the saved bytes show up on every page
// that pulls `lib/utils` into its chunk.
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase();
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
    return then.toLocaleDateString("en-US", { weekday: "short", timeZone: tz });
  }
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
}

/** Time stamp inside the message thread. */
export function formatMessageTime(iso: string, tz?: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  });
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
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: tz,
  });
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

/**
 * Format a phone number for display in international form, e.g.
 * "+961 71 505 894". Uses libphonenumber-js so the country-code split and
 * national-number grouping match each country's conventions (a hand-rolled
 * heuristic mis-grouped 3-digit codes like +961 as "+96 1...").
 *
 * Falls back to a "+digits" string if parsing fails — Meta's
 * `display_phone_number` can arrive without a + or be otherwise malformed,
 * and we'd rather show *something* than crash.
 */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withPlus = trimmed.startsWith("+") ? trimmed : `+${trimmed.replace(/[^\d]/g, "")}`;
  const parsed = parsePhoneNumberFromString(withPlus);
  if (parsed) return parsed.formatInternational();
  const digits = trimmed.replace(/\D/g, "");
  return digits ? `+${digits}` : raw;
}

/**
 * Derive a contact's ISO 3166-1 alpha-2 country code from their phone number
 * via libphonenumber-js. Returns null when the input is missing/unparseable.
 *
 * Used at write time on new contacts (inbound webhook ingest + /v1 POST/PATCH)
 * so the outbound webhook payload's `country_code` is populated without a
 * lookup table maintained in app code. Pure function — safe to call on the
 * hot path; libphonenumber's /min metadata bundle is already in our bundle
 * via `formatPhone`.
 */
export function getCountryFromPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withPlus = trimmed.startsWith("+") ? trimmed : `+${trimmed.replace(/[^\d]/g, "")}`;
  const parsed = parsePhoneNumberFromString(withPlus);
  return parsed?.country ?? null;
}

/**
 * Display string for a contact's natural identity:
 *   - Phone number when set (WhatsApp/SMS contacts).
 *   - "instagram:<id>", "telegram:<id>", … for channel-native identities.
 *   - "—" fallback when neither is present (shouldn't happen post-ingest).
 *
 * Use this everywhere a contact is rendered as a single line and the UI
 * doesn't already have a richer surface (channel chip + handle). Keeps
 * non-phone contacts legible without forcing every component to learn the
 * multi-channel identity model.
 */
export function formatContactIdentity(contact: {
  phoneNumber: string | null;
  identityChannel?: string | null;
  externalContactId?: string | null;
}): string {
  if (contact.phoneNumber) return formatPhone(contact.phoneNumber);
  if (contact.identityChannel && contact.externalContactId) {
    const channel = contact.identityChannel.replace(/_/g, " ");
    return `${channel}:${contact.externalContactId}`;
  }
  return "—";
}
