"use client";

import { useMemo } from "react";

import { useChannelAccounts } from "@/features/channels/contexts/channel-accounts-context";
import { cn } from "@ccp/shared/utils";

/**
 * The range + account-scope controls shared by the /reports pages (overview +
 * team). Presentational and controlled — each page owns the state, so the two
 * tabs stay independent while looking identical.
 */

export const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

/** The API rejects ranges past 366 days — mirror the cap in the picker. */
const MAX_CUSTOM_DAYS = 366;

/**
 * What the range controls hold: a rolling preset, or an explicit pair of
 * calendar dates (yyyy-mm-dd, INCLUSIVE — "Jul 1 to Jul 3" means three whole
 * local days, because that is what a person picking dates means).
 */
export type ReportRangeSelection =
  | { kind: "preset"; days: number }
  | { kind: "custom"; from: string; to: string };

export const DEFAULT_RANGE: ReportRangeSelection = { kind: "preset", days: 30 };

function localDateToMidnight(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The [from, to) window for a range selection. "Today" (preset days === 1)
 * starts at the BROWSER's midnight — "how many calls did he have today" means
 * the calendar day, not the trailing 24 hours — which also matches how the
 * daily buckets flip (the tz travels with the request). Multi-day presets are
 * trailing windows ending now. Custom dates are inclusive whole local days:
 * [from 00:00, to+1d 00:00).
 */
export function computeReportRange(sel: ReportRangeSelection): { from: Date; to: Date } {
  if (sel.kind === "custom") {
    const from = localDateToMidnight(sel.from);
    const to = new Date(localDateToMidnight(sel.to).getTime() + 24 * 60 * 60 * 1000);
    return { from, to };
  }
  const to = new Date();
  if (sel.days === 1) {
    const from = new Date(to);
    from.setHours(0, 0, 0, 0);
    return { from, to };
  }
  return { from: new Date(to.getTime() - sel.days * 24 * 60 * 60 * 1000), to };
}

/** Whole days a selection spans — for consumers sized in days (spend panel). */
export function rangeSelectionDays(sel: ReportRangeSelection): number {
  const { from, to } = computeReportRange(sel);
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
}

/** A custom pair is orderable and within the API's range cap. */
function customIsValid(from: string, to: string): boolean {
  if (!from || !to) return false;
  const f = localDateToMidnight(from);
  const t = localDateToMidnight(to);
  if (f.getTime() > t.getTime()) return false;
  return (t.getTime() - f.getTime()) / (24 * 60 * 60 * 1000) < MAX_CUSTOM_DAYS;
}

/**
 * Accounts worth offering as a report scope: only those on channels that
 * actually hold more than one — the same "attribution is a disambiguator"
 * rule the inbox chip follows, so a single-number workspace sees no control
 * at all.
 */
export function useScopeAccounts() {
  const { all: allAccounts } = useChannelAccounts();
  return useMemo(() => {
    const perChannel = new Map<string, number>();
    for (const a of allAccounts) {
      if (a.isActive) perChannel.set(a.channel, (perChannel.get(a.channel) ?? 0) + 1);
    }
    return allAccounts.filter((a) => a.isActive && (perChannel.get(a.channel) ?? 0) > 1);
  }, [allAccounts]);
}

export function ReportControls({
  value,
  onChange,
  accountId,
  onAccountChange,
}: {
  value: ReportRangeSelection;
  onChange: (sel: ReportRangeSelection) => void;
  accountId: string | null;
  onAccountChange: (accountId: string | null) => void;
}) {
  const scopeAccounts = useScopeAccounts();
  const isCustom = value.kind === "custom";

  const enterCustom = () => {
    if (isCustom) return;
    // Seed from the preset currently shown so switching modes doesn't jump
    // the data — the same window, now editable.
    const { from, to } = computeReportRange(value);
    onChange({
      kind: "custom",
      from: toDateInputValue(from),
      to: toDateInputValue(to),
    });
  };
  const setCustom = (from: string, to: string) => {
    // An incomplete or inverted pair simply doesn't fire — the last valid
    // range keeps rendering while the user is mid-edit.
    if (customIsValid(from, to)) onChange({ kind: "custom", from, to });
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {/* Account scope. Hidden entirely unless some channel actually holds
          more than one account — a single-number workspace has nothing to
          disambiguate and the control would be pure noise. */}
      {scopeAccounts.length > 0 && (
        <select
          value={accountId ?? ""}
          onChange={(e) => onAccountChange(e.target.value || null)}
          aria-label="Scope the report to one account"
          className="h-8 rounded-lg border border-border bg-card px-2 text-xs"
        >
          <option value="">All accounts</option>
          {scopeAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      )}
      {isCustom && (
        <div className="flex items-center gap-1">
          <input
            type="date"
            value={value.from}
            max={value.to}
            onChange={(e) => setCustom(e.target.value, value.to)}
            aria-label="Report start date"
            className="h-8 rounded-lg border border-border bg-card px-2 text-xs"
          />
          <span className="text-xs text-muted-foreground">–</span>
          <input
            type="date"
            value={value.to}
            min={value.from}
            onChange={(e) => setCustom(value.from, e.target.value)}
            aria-label="Report end date"
            className="h-8 rounded-lg border border-border bg-card px-2 text-xs"
          />
        </div>
      )}
      <div
        role="radiogroup"
        aria-label="Report range"
        className="flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5"
      >
        {RANGES.map((r) => (
          <button
            key={r.days}
            type="button"
            role="radio"
            aria-checked={!isCustom && value.days === r.days}
            onClick={() => onChange({ kind: "preset", days: r.days })}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              !isCustom && value.days === r.days
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {r.label}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={isCustom}
          onClick={enterCustom}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            isCustom
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          Custom
        </button>
      </div>
    </div>
  );
}
