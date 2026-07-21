"use client";

import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@ccp/shared/utils";
import {
  DAY_KEYS,
  DAY_LABELS,
  isScheduleEmpty,
  type DayKey,
  type TimeWindow,
  type WorkHours,
} from "@ccp/shared/work-hours";

/**
 * The one working-hours grid, shared by the org default (Settings → Team) and
 * the per-member dialog. Editing a whole `WorkHours` value — timezone + the
 * weekly grid — rather than loose fields, so callers just hand it a value and
 * take the new one back.
 *
 * Deliberately NOT merged with the AI assistant's opening-hours grid: that one
 * edits three separate config fields on a stable settings page and supports one
 * window per day. Rewriting it to share this component would churn working code
 * for no behavior gain.
 *
 * Split shifts are the reason for multiple windows a day (09:00–13:00 +
 * 14:00–18:00). A window whose close is at or before its open runs past
 * midnight — that's a supported night shift, and the hint says so rather than
 * rejecting it.
 */

// Full IANA zone list where the runtime has it (every modern browser), with a
// small MENA/EU/US fallback for older engines.
const TIMEZONES: string[] = (() => {
  const sv = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const all = sv ? sv("timeZone") : [];
  // "UTC" is the obvious pick for a distributed team and is NOT in every
  // engine's supportedValuesOf output, so make sure it's always offered.
  if (all.length) return all.includes("UTC") ? all : ["UTC", ...all];
  return [
    "UTC", "Asia/Beirut", "Asia/Dubai", "Asia/Riyadh", "Asia/Amman", "Asia/Baghdad",
    "Africa/Cairo", "Europe/Istanbul", "Europe/London", "Europe/Paris", "Europe/Berlin",
    "America/New_York", "America/Chicago", "America/Los_Angeles",
  ];
})();

const DEFAULT_WINDOW: TimeWindow = { open: "09:00", close: "17:00" };
const MAX_WINDOWS_PER_DAY = 4;

/** A sensible starting grid: Mon–Fri 09:00–17:00 in the viewer's own zone. */
export function defaultWorkHours(): WorkHours {
  let timezone = "UTC";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    // Keep UTC — a runtime without a resolvable zone is still usable.
  }
  return {
    timezone,
    weekly: {
      mon: [{ ...DEFAULT_WINDOW }],
      tue: [{ ...DEFAULT_WINDOW }],
      wed: [{ ...DEFAULT_WINDOW }],
      thu: [{ ...DEFAULT_WINDOW }],
      fri: [{ ...DEFAULT_WINDOW }],
    },
  };
}

export function WorkHoursEditor({
  value,
  onChange,
  disabled,
}: {
  value: WorkHours;
  onChange: (next: WorkHours) => void;
  disabled?: boolean;
}) {
  const setWeekly = (day: DayKey, windows: TimeWindow[] | undefined) => {
    const weekly = { ...value.weekly };
    if (windows && windows.length > 0) weekly[day] = windows;
    else delete weekly[day];
    onChange({ ...value, weekly });
  };

  const copyToWeekdays = () => {
    const monday = value.weekly.mon;
    if (!monday || monday.length === 0) return;
    onChange({
      ...value,
      weekly: {
        ...value.weekly,
        tue: monday.map((w) => ({ ...w })),
        wed: monday.map((w) => ({ ...w })),
        thu: monday.map((w) => ({ ...w })),
        fri: monday.map((w) => ({ ...w })),
      },
    });
  };

  const empty = isScheduleEmpty(value);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-56 flex-1 flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Timezone</span>
          <Select
            value={value.timezone}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, timezone: e.target.value })}
            aria-label="Schedule timezone"
          >
            {/* The saved zone is always an option, even when this runtime's
                `Intl.supportedValuesOf` doesn't list it (it omits plain "UTC"
                in some engines, and a zone can be retired between releases).
                Without this the select renders with nothing selected and the
                first blind save silently rewrites the team's timezone. */}
            {(TIMEZONES.includes(value.timezone)
              ? TIMEZONES
              : [value.timezone, ...TIMEZONES]
            ).map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </Select>
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || !value.weekly.mon?.length}
          onClick={copyToWeekdays}
        >
          Copy Monday to Tue–Fri
        </Button>
      </div>

      <div className="divide-y divide-border/60 rounded-lg border border-border/60">
        {DAY_KEYS.map((day) => {
          const windows = value.weekly[day] ?? [];
          const open = windows.length > 0;
          return (
            <div key={day} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="flex w-40 shrink-0 items-center gap-2.5">
                <Switch
                  checked={open}
                  disabled={disabled}
                  onCheckedChange={(next) =>
                    setWeekly(day, next ? [{ ...DEFAULT_WINDOW }] : undefined)
                  }
                  aria-label={`${DAY_LABELS[day]} working`}
                />
                <span
                  className={cn(
                    "text-sm font-medium",
                    !open && "text-muted-foreground",
                  )}
                >
                  {DAY_LABELS[day]}
                </span>
              </div>

              {open ? (
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  {windows.map((w, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <Input
                        type="time"
                        value={w.open}
                        disabled={disabled}
                        aria-label={`${DAY_LABELS[day]} start`}
                        className="w-28"
                        onChange={(e) =>
                          setWeekly(
                            day,
                            windows.map((x, j) =>
                              j === i ? { ...x, open: e.target.value } : x,
                            ),
                          )
                        }
                      />
                      <span className="text-muted-foreground">–</span>
                      <Input
                        type="time"
                        value={w.close}
                        disabled={disabled}
                        aria-label={`${DAY_LABELS[day]} end`}
                        className="w-28"
                        onChange={(e) =>
                          setWeekly(
                            day,
                            windows.map((x, j) =>
                              j === i ? { ...x, close: e.target.value } : x,
                            ),
                          )
                        }
                      />
                      {windows.length > 1 && (
                        <button
                          type="button"
                          disabled={disabled}
                          aria-label={`Remove ${DAY_LABELS[day]} window ${i + 1}`}
                          className="cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          onClick={() =>
                            setWeekly(day, windows.filter((_, j) => j !== i))
                          }
                        >
                          <X className="size-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                  {windows.length < MAX_WINDOWS_PER_DAY && (
                    <button
                      type="button"
                      disabled={disabled}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      onClick={() => setWeekly(day, [...windows, { ...DEFAULT_WINDOW }])}
                    >
                      <Plus className="size-3" />
                      Split shift
                    </button>
                  )}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">Day off</span>
              )}
            </div>
          );
        })}
      </div>

      {empty ? (
        // Loud, because it's the failure mode worth preventing: a saved-but-blank
        // grid does NOT mark everyone away — it's treated as "no schedule" — and
        // an admin who expected otherwise should learn that here, not from
        // wondering why nobody ever goes off shift.
        <p className="text-xs text-amber-600 dark:text-amber-500">
          No working days set — this schedule is inactive and availability stays manual.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Outside these hours members show as away automatically and are skipped by
          round-robin assignment. An end time before the start time (22:00–06:00)
          runs overnight.
        </p>
      )}
    </div>
  );
}
