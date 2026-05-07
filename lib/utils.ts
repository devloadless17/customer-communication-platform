import { clsx, type ClassValue } from "clsx";
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
 * Format a phone number for display: keeps the leading + and groups the rest
 * loosely. Don't rely on this for canonicalization — that's libphonenumber's job.
 */
export function formatPhone(raw: string): string {
  const trimmed = raw.replace(/[^\d+]/g, "");
  if (!trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.slice(1);
  if (digits.length <= 4) return trimmed;
  // crude grouping: country (1-3) + rest in chunks of 3
  const country = digits.slice(0, digits.length - 9 > 0 ? digits.length - 9 : 1);
  const rest = digits.slice(country.length);
  const grouped = rest.match(/.{1,3}/g)?.join(" ") ?? rest;
  return `+${country} ${grouped}`.trim();
}
