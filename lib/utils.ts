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

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** Compact relative time used in the conversation list ("now", "12m", "3h", "Mon", "Mar 4"). */
export function formatListTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diffSec = Math.round((then.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);

  if (abs < 60) return "now";
  if (abs < 3600) return `${Math.round(abs / 60)}m`;
  if (abs < 86400) return `${Math.round(abs / 3600)}h`;
  if (abs < 86400 * 7) {
    return then.toLocaleDateString("en-US", { weekday: "short" });
  }
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Time stamp inside the message thread. */
export function formatMessageTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Day separator label used between message clusters. */
export function formatDaySeparator(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const thatDay = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const diffDays = Math.round((today.getTime() - thatDay.getTime()) / 86400000);

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return then.toLocaleDateString("en-US", { weekday: "long" });
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
  identityProvider?: string | null;
  externalContactId?: string | null;
}): string {
  if (contact.phoneNumber) return formatPhone(contact.phoneNumber);
  if (contact.identityProvider && contact.externalContactId) {
    const channel = contact.identityProvider.replace(/_/g, " ");
    return `${channel}:${contact.externalContactId}`;
  }
  return "—";
}
