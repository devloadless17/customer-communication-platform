/**
 * Working-hours schedule: the shape, and the pure time math over it.
 *
 * A schedule answers exactly two questions:
 *   - is this person on shift RIGHT NOW?            → isWithinWorkHours()
 *   - when does that answer next change?            → nextBoundary()
 *
 * Everything here is pure and dependency-free so it can run in the API domain
 * layer, in the boundary sweeper, and in the browser from the same source.
 * Timezone math goes through cached `Intl.DateTimeFormat` instances — the same
 * pattern (and the same reasoning) as the formatter caches in ./utils.ts: the
 * constructor is the expensive part, `formatToParts` is cheap, and letting the
 * platform own the tz database means DST transitions are correct for free with
 * no new dependency.
 *
 * The schedule is stored as JSON (Team.workHours / User.workHours) rather than
 * columns, for the same reason the AI assistant's opening hours are: it's a
 * whole-value setting that is always read and written together, and adding a
 * field to it must not be a migration.
 */

/** Day keys, Monday-first — the canonical UI order and the `weekly` map keys. */
export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export const DAY_LABELS: Record<DayKey, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** A single wall-clock window in the schedule's timezone. `HH:MM`, 24h. */
export interface TimeWindow {
  open: string;
  close: string;
}

/**
 * A dated override for one calendar day (`YYYY-MM-DD` in the schedule's tz).
 * `closed: true` wins over `windows`; `windows` replaces that weekday's set.
 */
export interface ScheduleException {
  date: string;
  closed?: boolean;
  windows?: TimeWindow[];
}

export interface WorkHours {
  /** IANA zone, e.g. "Asia/Beirut". Invalid values fall back to UTC. */
  timezone: string;
  /** Weekday → windows. A missing/empty day is a day off. */
  weekly: Partial<Record<DayKey, TimeWindow[]>>;
  exceptions?: ScheduleException[];
}

/** Where a user's schedule comes from. `off` opts out of an inherited one. */
export type WorkHoursMode = "inherit" | "custom" | "off";
export const ALL_WORK_HOURS_MODES: WorkHoursMode[] = ["inherit", "custom", "off"];

/** Who/what decided the availability currently displayed for a user. */
export type AvailabilitySource = "manual" | "admin" | "schedule";

/** The note shown to teammates while a scheduled user is off shift. */
export const OFF_SHIFT_MESSAGE = "Outside working hours";

/** How far ahead nextBoundary() will look before giving up. */
const LOOKAHEAD_DAYS = 14;
const MINUTES_PER_DAY = 24 * 60;

/* -------------------------------------------------------------------------
 * Parsing / validation helpers
 * ------------------------------------------------------------------------- */

/** `HH:MM` (or `HH:MM:SS`) → minutes past local midnight, or null if unparsable. */
export function parseTimeOfDay(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** True when a zone string is one `Intl` accepts. Used by the Zod refinement. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A schedule with no usable window on ANY day is treated as "not configured"
 * rather than "off shift forever".
 *
 * This is a safety rule, not a convenience: an admin who enables working hours
 * and saves before filling the grid in would otherwise mark their entire org
 * permanently away — dropping every agent out of round-robin at once. Callers
 * must route a schedule through here (resolveSchedule does) so a blank grid
 * degrades to today's manual-only behavior.
 */
export function isScheduleEmpty(schedule: WorkHours | null | undefined): boolean {
  if (!schedule) return true;
  for (const day of DAY_KEYS) {
    for (const w of schedule.weekly?.[day] ?? []) {
      if (parseTimeOfDay(w.open) !== null && parseTimeOfDay(w.close) !== null) return false;
    }
  }
  return true;
}

/** Narrow unknown JSON (a Prisma `Json` column) to a WorkHours, or null. */
export function asWorkHours(value: unknown): WorkHours | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.timezone !== "string" || !v.weekly || typeof v.weekly !== "object") return null;
  return value as WorkHours;
}

/* -------------------------------------------------------------------------
 * Timezone math
 * ------------------------------------------------------------------------- */

const partFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = partFormatters.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "short",
      });
    } catch {
      // Unknown zone — fall back to UTC rather than throwing inside a sweeper.
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "short",
      });
    }
    partFormatters.set(tz, fmt);
  }
  return fmt;
}

const WEEKDAY_TO_KEY: Record<string, DayKey> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  minutes: number;
  day_key: DayKey;
  /** `YYYY-MM-DD` in the target zone — the exceptions map key. */
  dateKey: string;
}

/** Wall-clock parts of an instant, in a given zone. */
export function zonedParts(tz: string, atMs: number): ZonedParts {
  const parts = partsFormatter(tz).formatToParts(new Date(atMs));
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(pick("year"));
  const month = Number(pick("month"));
  const day = Number(pick("day"));
  const hour = Number(pick("hour"));
  const minute = Number(pick("minute"));
  return {
    year,
    month,
    day,
    minutes: hour * 60 + minute,
    day_key: WEEKDAY_TO_KEY[pick("weekday")] ?? "mon",
    dateKey: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** Offset (ms) to ADD to a UTC instant to get the zone's wall clock. */
function zoneOffsetMs(tz: string, atMs: number): number {
  const p = zonedParts(tz, atMs);
  const parts = partsFormatter(tz).formatToParts(new Date(atMs));
  const second = Number(parts.find((x) => x.type === "second")?.value ?? "0");
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, 0, p.minutes, second);
  // Round to the second: formatToParts drops sub-second precision, so comparing
  // against the raw instant would leak the milliseconds into the offset.
  return asIfUtc - Math.floor(atMs / 1000) * 1000;
}

/**
 * Wall-clock date+minutes in `tz` → the UTC instant.
 *
 * Two-pass: the first guess uses the offset at the naive instant, the second
 * re-reads the offset AT that corrected instant. That second pass is what makes
 * DST-transition days correct — the offset before and after a jump differs, and
 * a single pass picks the wrong one for times near the boundary. Times that
 * don't exist (the spring-forward gap) resolve to the instant the clock jumps
 * to, which is the behavior a shift schedule wants.
 */
export function zonedTimeToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  minutes: number,
): number {
  const naive = Date.UTC(year, month - 1, day, 0, minutes);
  const first = naive - zoneOffsetMs(tz, naive);
  return naive - zoneOffsetMs(tz, first);
}

/** Shift a `YYYY-MM-DD`-style civil date by N days (no tz involved). */
function addDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number; dateKey: string; day_key: DayKey } {
  const d = new Date(Date.UTC(year, month - 1, day + delta));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  return {
    year: y,
    month: m,
    day: dd,
    dateKey: `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
    // getUTCDay: 0=Sun. DAY_KEYS is Monday-first.
    day_key: DAY_KEYS[(d.getUTCDay() + 6) % 7]!,
  };
}

/* -------------------------------------------------------------------------
 * Intervals
 * ------------------------------------------------------------------------- */

export interface ShiftInterval {
  start: number;
  end: number;
}

/** The windows that apply on one civil day, honoring exceptions. */
function windowsForDay(
  schedule: WorkHours,
  dateKey: string,
  day_key: DayKey,
): TimeWindow[] {
  const exception = schedule.exceptions?.find((e) => e.date === dateKey);
  if (exception) {
    if (exception.closed) return [];
    // An exception that EXPLICITLY carries `windows` replaces the weekday's
    // set — including when that array is empty, which means "closed".
    // Previously an empty array fell through to the weekly grid, so a `/v1`
    // integration posting `{ date: "2026-12-25", windows: [] }` to close
    // Christmas got a fully OPEN Christmas instead. `windows` absent (vs
    // present-but-empty) still means "inherit the weekday".
    if (exception.windows !== undefined) return exception.windows;
  }
  return schedule.weekly?.[day_key] ?? [];
}

/**
 * Concrete UTC intervals for the civil days [fromOffset, toOffset] around the
 * day containing `anchorMs`.
 *
 * A window whose close is at or before its open (22:00→06:00) spills into the
 * next day — that's how a night shift is expressed, so it's a supported shape,
 * not a validation error. Intervals are emitted sorted by start.
 */
export function shiftIntervals(
  schedule: WorkHours,
  anchorMs: number,
  fromOffset: number,
  toOffset: number,
): ShiftInterval[] {
  const tz = schedule.timezone;
  const anchor = zonedParts(tz, anchorMs);
  const out: ShiftInterval[] = [];
  for (let offset = fromOffset; offset <= toOffset; offset++) {
    const d = addDays(anchor.year, anchor.month, anchor.day, offset);
    for (const w of windowsForDay(schedule, d.dateKey, d.day_key)) {
      const open = parseTimeOfDay(w.open);
      const close = parseTimeOfDay(w.close);
      if (open === null || close === null) continue;
      const start = zonedTimeToUtc(tz, d.year, d.month, d.day, open);
      // close <= open means the window runs past midnight into the next day.
      const end =
        close > open
          ? zonedTimeToUtc(tz, d.year, d.month, d.day, close)
          : zonedTimeToUtc(tz, d.year, d.month, d.day, close + MINUTES_PER_DAY);
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/* -------------------------------------------------------------------------
 * The two questions
 * ------------------------------------------------------------------------- */

/** Is the schedule "open" at this instant? An empty schedule is never open. */
export function isWithinWorkHours(
  schedule: WorkHours | null | undefined,
  nowMs: number,
): boolean {
  if (!schedule || isScheduleEmpty(schedule)) return false;
  // -1 covers a window that started yesterday and runs past midnight.
  return shiftIntervals(schedule, nowMs, -1, 1).some(
    (i) => nowMs >= i.start && nowMs < i.end,
  );
}

/**
 * The next instant at which `isWithinWorkHours` flips, or null when nothing
 * changes inside the lookahead window (a schedule that never opens again).
 *
 * `opens: true` means the flip is off-shift → on-shift.
 */
export function nextBoundary(
  schedule: WorkHours | null | undefined,
  nowMs: number,
): { at: number; opens: boolean } | null {
  if (!schedule || isScheduleEmpty(schedule)) return null;
  const horizonMs = nowMs + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000;
  const intervals = shiftIntervals(schedule, nowMs, -1, LOOKAHEAD_DAYS);
  const current = intervals.find((i) => nowMs >= i.start && nowMs < i.end);
  if (current) {
    // On shift: the boundary is this shift's end — unless a back-to-back or
    // overlapping window carries straight on from it, in which case the person
    // never actually goes off shift there. Walk the chain to its real end.
    let end = current.end;
    for (const i of intervals) {
      if (i.start <= end && i.end > end) end = i.end;
    }
    // A 24/7 grid (each day's window starting exactly where the previous one
    // ended) chains all the way to the lookahead horizon — it has no boundary
    // at all. Report none rather than the arbitrary horizon date, so a manual
    // pick on an always-open schedule holds indefinitely, exactly as it does
    // with no schedule. Returning the horizon instead would hand the user a
    // meaningless "until <14 days from now>" expiry.
    if (end >= horizonMs) return null;
    return { at: end, opens: false };
  }
  const upcoming = intervals.find((i) => i.start > nowMs);
  return upcoming ? { at: upcoming.start, opens: true } : null;
}

/**
 * Short human phrase for when the person is back — "back Mon 9:00", "back at
 * 14:30" for later today. Rendered in the schedule note teammates see, so it's
 * formatted in the SCHEDULE's zone (the absent person's working day), not the
 * viewer's.
 */
export function describeNextOpen(
  schedule: WorkHours | null | undefined,
  nowMs: number,
): string | null {
  const boundary = nextBoundary(schedule, nowMs);
  if (!boundary || !boundary.opens || !schedule) return null;
  const now = zonedParts(schedule.timezone, nowMs);
  const then = zonedParts(schedule.timezone, boundary.at);
  const hh = String(Math.floor(then.minutes / 60)).padStart(2, "0");
  const mm = String(then.minutes % 60).padStart(2, "0");
  const time = `${hh}:${mm}`;
  if (then.dateKey === now.dateKey) return `back at ${time}`;
  const tomorrow = addDays(now.year, now.month, now.day, 1);
  if (then.dateKey === tomorrow.dateKey) return `back tomorrow ${time}`;
  return `back ${DAY_LABELS[then.day_key].slice(0, 3)} ${time}`;
}

/**
 * The next local midnight in the schedule's zone.
 *
 * The anchor of last resort for an override expiry: a 24/7 schedule has no
 * boundary to hang one on, but the promise this feature makes — an override
 * never outlives the day it was made in — still has to hold for a team that
 * runs around the clock.
 */
export function nextLocalMidnight(tz: string, nowMs: number): number {
  const p = zonedParts(tz, nowMs);
  const tomorrow = addDays(p.year, p.month, p.day, 1);
  return zonedTimeToUtc(tz, tomorrow.year, tomorrow.month, tomorrow.day, 0);
}

/** The full off-shift note: "Outside working hours · back Mon 09:00". */
export function offShiftMessage(
  schedule: WorkHours | null | undefined,
  nowMs: number,
): string {
  const next = describeNextOpen(schedule, nowMs);
  return next ? `${OFF_SHIFT_MESSAGE} · ${next}` : OFF_SHIFT_MESSAGE;
}
