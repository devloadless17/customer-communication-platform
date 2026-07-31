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

/**
 * The [from, to) window for a range selection. "Today" (days === 1) starts at
 * the BROWSER's midnight — "how many calls did he have today" means the
 * calendar day, not the trailing 24 hours — which also matches how the daily
 * buckets flip (the tz travels with the request). The multi-day presets stay
 * trailing windows ending now.
 */
export function computeReportRange(days: number): { from: Date; to: Date } {
  const to = new Date();
  if (days === 1) {
    const from = new Date(to);
    from.setHours(0, 0, 0, 0);
    return { from, to };
  }
  return { from: new Date(to.getTime() - days * 24 * 60 * 60 * 1000), to };
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
  days,
  onDaysChange,
  accountId,
  onAccountChange,
}: {
  days: number;
  onDaysChange: (days: number) => void;
  accountId: string | null;
  onAccountChange: (accountId: string | null) => void;
}) {
  const scopeAccounts = useScopeAccounts();
  return (
    <div className="flex items-center gap-2">
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
            aria-checked={days === r.days}
            onClick={() => onDaysChange(r.days)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              days === r.days
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  );
}
