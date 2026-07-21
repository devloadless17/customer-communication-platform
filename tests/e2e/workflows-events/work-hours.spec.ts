import { test, expect } from "@playwright/test";

import {
  describeNextOpen,
  isWithinWorkHours,
  nextBoundary,
  isScheduleEmpty,
  zonedTimeToUtc,
  type WorkHours,
} from "../../../packages/shared/src/work-hours";
import {
  overrideExpiryFor,
  resolveEffectiveAvailability,
} from "../../../packages/shared/src/presence";

/**
 * The pure working-hours math + the availability rule built on it.
 *
 * These are the parts that decide whether an agent who went home is still
 * taking conversations, so they're worth testing without a stack: DST
 * transitions, overnight shifts, dated exceptions, and the four branches of
 * the effective-availability resolver.
 */

const BEIRUT = "Asia/Beirut"; // EET/EEST, DST last Sunday of March/October
const nineToFive: WorkHours = {
  timezone: BEIRUT,
  weekly: {
    mon: [{ open: "09:00", close: "17:00" }],
    tue: [{ open: "09:00", close: "17:00" }],
    wed: [{ open: "09:00", close: "17:00" }],
    thu: [{ open: "09:00", close: "17:00" }],
    fri: [{ open: "09:00", close: "17:00" }],
  },
};

/** Local wall-clock in the schedule's zone → instant. */
const at = (y: number, m: number, d: number, hh: number, mm = 0) =>
  zonedTimeToUtc(BEIRUT, y, m, d, hh * 60 + mm);

test.describe("isWithinWorkHours", () => {
  test("inside and outside a normal weekday window", () => {
    // 2026-07-22 is a Wednesday.
    expect(isWithinWorkHours(nineToFive, at(2026, 7, 22, 10))).toBe(true);
    expect(isWithinWorkHours(nineToFive, at(2026, 7, 22, 8, 59))).toBe(false);
    // Exclusive at the close instant — 17:00 is off shift, not the last second on.
    expect(isWithinWorkHours(nineToFive, at(2026, 7, 22, 17))).toBe(false);
  });

  test("a day with no windows is off shift all day", () => {
    // 2026-07-25 is a Saturday — not in `weekly`.
    expect(isWithinWorkHours(nineToFive, at(2026, 7, 25, 12))).toBe(false);
  });

  test("an overnight window (22:00–06:00) spills into the next morning", () => {
    const nightShift: WorkHours = {
      timezone: BEIRUT,
      weekly: { wed: [{ open: "22:00", close: "06:00" }] },
    };
    // Wednesday 23:00 — inside.
    expect(isWithinWorkHours(nightShift, at(2026, 7, 22, 23))).toBe(true);
    // Thursday 05:00 — still inside Wednesday's window.
    expect(isWithinWorkHours(nightShift, at(2026, 7, 23, 5))).toBe(true);
    // Thursday 07:00 — out.
    expect(isWithinWorkHours(nightShift, at(2026, 7, 23, 7))).toBe(false);
  });

  test("a dated exception closes a normally-working day", () => {
    const withHoliday: WorkHours = {
      ...nineToFive,
      exceptions: [{ date: "2026-07-22", closed: true }],
    };
    expect(isWithinWorkHours(withHoliday, at(2026, 7, 22, 10))).toBe(false);
    // The next day is unaffected.
    expect(isWithinWorkHours(withHoliday, at(2026, 7, 23, 10))).toBe(true);
  });

  test("a dated exception can REPLACE the day's windows", () => {
    const halfDay: WorkHours = {
      ...nineToFive,
      exceptions: [{ date: "2026-07-22", windows: [{ open: "09:00", close: "12:00" }] }],
    };
    expect(isWithinWorkHours(halfDay, at(2026, 7, 22, 11))).toBe(true);
    expect(isWithinWorkHours(halfDay, at(2026, 7, 22, 14))).toBe(false);
  });

  test("survives a DST transition — 10:00 local is on shift either side", () => {
    // Beirut springs forward on 2026-03-29 (a Sunday), falls back 2026-10-25.
    expect(isWithinWorkHours(nineToFive, at(2026, 3, 27, 10))).toBe(true); // Fri, EET
    expect(isWithinWorkHours(nineToFive, at(2026, 3, 30, 10))).toBe(true); // Mon, EEST
    expect(isWithinWorkHours(nineToFive, at(2026, 10, 23, 10))).toBe(true); // Fri, EEST
    expect(isWithinWorkHours(nineToFive, at(2026, 10, 26, 10))).toBe(true); // Mon, EET
    // …and 08:00 local is off shift on both sides, which is what would break
    // if the zone offset were captured once instead of per-instant.
    expect(isWithinWorkHours(nineToFive, at(2026, 3, 27, 8))).toBe(false);
    expect(isWithinWorkHours(nineToFive, at(2026, 3, 30, 8))).toBe(false);
  });

  test("an all-blank grid is treated as NO schedule, never as always-off", () => {
    const blank: WorkHours = { timezone: BEIRUT, weekly: {} };
    expect(isScheduleEmpty(blank)).toBe(true);
    // The safety rule: an admin who saves an empty grid must not mark the whole
    // org away forever.
    expect(isWithinWorkHours(blank, at(2026, 7, 22, 10))).toBe(false);
    expect(nextBoundary(blank, at(2026, 7, 22, 10))).toBeNull();
  });
});

test.describe("nextBoundary", () => {
  test("on shift → the end of the current shift", () => {
    const b = nextBoundary(nineToFive, at(2026, 7, 22, 10));
    expect(b?.opens).toBe(false);
    expect(b?.at).toBe(at(2026, 7, 22, 17));
  });

  test("off shift → the next opening", () => {
    const b = nextBoundary(nineToFive, at(2026, 7, 22, 18));
    expect(b?.opens).toBe(true);
    expect(b?.at).toBe(at(2026, 7, 23, 9));
  });

  test("skips the weekend to Monday", () => {
    // Friday evening.
    const b = nextBoundary(nineToFive, at(2026, 7, 24, 18));
    expect(b?.opens).toBe(true);
    expect(b?.at).toBe(at(2026, 7, 27, 9)); // Monday
  });

  test("back-to-back windows chain into ONE shift end", () => {
    // A split shift with no gap must not report a boundary at the seam — the
    // person never actually goes off shift there.
    const split: WorkHours = {
      timezone: BEIRUT,
      weekly: {
        wed: [
          { open: "09:00", close: "13:00" },
          { open: "13:00", close: "18:00" },
        ],
      },
    };
    const b = nextBoundary(split, at(2026, 7, 22, 10));
    expect(b?.at).toBe(at(2026, 7, 22, 18));
  });

  test("a real gap in a split shift DOES produce a boundary", () => {
    const lunch: WorkHours = {
      timezone: BEIRUT,
      weekly: {
        wed: [
          { open: "09:00", close: "13:00" },
          { open: "14:00", close: "18:00" },
        ],
      },
    };
    expect(nextBoundary(lunch, at(2026, 7, 22, 10))?.at).toBe(at(2026, 7, 22, 13));
  });
});

test.describe("describeNextOpen", () => {
  test("later today vs tomorrow vs a named day", () => {
    // Wed 07:00 → opens 09:00 the same day.
    expect(describeNextOpen(nineToFive, at(2026, 7, 22, 7))).toBe("back at 09:00");
    // Wed 18:00 → opens Thursday.
    expect(describeNextOpen(nineToFive, at(2026, 7, 22, 18))).toBe("back tomorrow 09:00");
    // Fri 18:00 → opens Monday.
    expect(describeNextOpen(nineToFive, at(2026, 7, 24, 18))).toBe("back Mon 09:00");
  });

  test("null while on shift (nothing to come back from)", () => {
    expect(describeNextOpen(nineToFive, at(2026, 7, 22, 10))).toBeNull();
  });
});

test.describe("resolveEffectiveAvailability", () => {
  const base = {
    manualStatus: "busy" as const,
    manualMessage: "In a meeting",
    manualSource: "manual" as const,
    overrideUntil: null,
  };

  test("NO schedule → the manual pick, forever (pre-feature behavior)", () => {
    const r = resolveEffectiveAvailability({
      ...base,
      schedule: null,
      nowMs: at(2026, 7, 22, 23),
    });
    expect(r.status).toBe("busy");
    expect(r.message).toBe("In a meeting");
    expect(r.overrideUntil).toBeNull();
  });

  test("live override → the manual pick wins over the schedule", () => {
    const now = at(2026, 7, 22, 10);
    const r = resolveEffectiveAvailability({
      ...base,
      overrideUntil: new Date(at(2026, 7, 22, 17)),
      schedule: nineToFive,
      nowMs: now,
    });
    expect(r.status).toBe("busy");
    expect(r.source).toBe("manual");
  });

  test("expired override on shift → back to available, manual note dropped", () => {
    const r = resolveEffectiveAvailability({
      ...base,
      // Expired an hour ago.
      overrideUntil: new Date(at(2026, 7, 22, 9)),
      schedule: nineToFive,
      nowMs: at(2026, 7, 22, 10),
    });
    expect(r.status).toBe("available");
    expect(r.message).toBeNull();
    expect(r.source).toBe("schedule");
  });

  test("off shift → away with an explanatory note", () => {
    const r = resolveEffectiveAvailability({
      ...base,
      schedule: nineToFive,
      nowMs: at(2026, 7, 22, 20),
    });
    expect(r.status).toBe("away");
    expect(r.message).toBe("Outside working hours · back tomorrow 09:00");
    expect(r.source).toBe("schedule");
  });

  test("an admin-set status keeps its provenance while the override is live", () => {
    const r = resolveEffectiveAvailability({
      ...base,
      manualSource: "admin",
      overrideUntil: new Date(at(2026, 7, 22, 17)),
      schedule: nineToFive,
      nowMs: at(2026, 7, 22, 10),
    });
    expect(r.source).toBe("admin");
    expect(r.status).toBe("busy");
  });

  test("a manual pick never destroys the note across an off-shift stretch", () => {
    // Off shift: teammates see the schedule's note…
    const offShift = resolveEffectiveAvailability({
      ...base,
      schedule: nineToFive,
      nowMs: at(2026, 7, 22, 22),
    });
    expect(offShift.message).toContain("Outside working hours");
    // …but the manual pair is untouched, so a later override still has it.
    const backOn = resolveEffectiveAvailability({
      ...base,
      overrideUntil: new Date(at(2026, 7, 23, 17)),
      schedule: nineToFive,
      nowMs: at(2026, 7, 23, 10),
    });
    expect(backOn.message).toBe("In a meeting");
  });
});

test.describe("appear-offline is sticky", () => {
  test("the schedule never revokes a manual `offline` at shift start", () => {
    // "Appear offline" is a PRIVACY choice, not an absence note. Reclaiming it
    // at 09:00 would put the user back in the visible-online set, back in the
    // widget's "an agent is here" dot, and back in the assignment tiers without
    // them ever touching the picker. busy/away are different — those describe a
    // temporary state and the schedule may legitimately clear them.
    const onShift = at(2026, 7, 22, 10);
    expect(isWithinWorkHours(nineToFive, onShift)).toBe(true);
    const r = resolveEffectiveAvailability({
      manualStatus: "offline",
      manualMessage: null,
      manualSource: "manual",
      overrideUntil: null,
      schedule: nineToFive,
      nowMs: onShift,
    });
    expect(r.status).toBe("offline");
  });

  test("busy IS reclaimed at shift start (the contrast that makes the rule a rule)", () => {
    const r = resolveEffectiveAvailability({
      manualStatus: "busy",
      manualMessage: "in a meeting",
      manualSource: "manual",
      overrideUntil: null,
      schedule: nineToFive,
      nowMs: at(2026, 7, 22, 10),
    });
    expect(r.status).toBe("available");
    expect(r.source).toBe("schedule");
  });
});

test.describe("overrideExpiryFor", () => {
  test("a mid-shift pick expires at shift END — the forgot-to-flip fix", () => {
    const expiry = overrideExpiryFor(nineToFive, at(2026, 7, 22, 14));
    expect(expiry?.getTime()).toBe(at(2026, 7, 22, 17));
  });

  test("an off-shift pick expires when the next shift STARTS", () => {
    const expiry = overrideExpiryFor(nineToFive, at(2026, 7, 22, 20));
    expect(expiry?.getTime()).toBe(at(2026, 7, 23, 9));
  });

  test("no schedule → no expiry (the pick holds indefinitely)", () => {
    expect(overrideExpiryFor(null, at(2026, 7, 22, 14))).toBeNull();
  });

  test("a 24/7 schedule has no boundary, so an override expires at local midnight", () => {
    // Each day's window starts exactly where the previous one ended, so the
    // person is never off shift and there is no boundary to report.
    const alwaysOpen: WorkHours = {
      timezone: BEIRUT,
      weekly: Object.fromEntries(
        (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((d) => [
          d,
          [{ open: "00:00", close: "00:00" }],
        ]),
      ),
    };
    expect(isWithinWorkHours(alwaysOpen, at(2026, 7, 22, 14))).toBe(true);
    expect(nextBoundary(alwaysOpen, at(2026, 7, 22, 14))).toBeNull();
    // But the override still has to be BOUNDED — a null expiry means "no
    // override", which would let the schedule reclaim the status instantly and
    // leave a 24/7 team unable to mark themselves busy at all. Midnight keeps
    // the promise that an override can't outlive the day.
    expect(overrideExpiryFor(alwaysOpen, at(2026, 7, 22, 14))?.getTime()).toBe(
      at(2026, 7, 23, 0),
    );
  });

  test("a 24/7 override survives the whole day, then hands back at midnight", () => {
    const alwaysOpen: WorkHours = {
      timezone: BEIRUT,
      weekly: Object.fromEntries(
        (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((d) => [
          d,
          [{ open: "00:00", close: "00:00" }],
        ]),
      ),
    };
    const until = overrideExpiryFor(alwaysOpen, at(2026, 7, 22, 14))!;
    // 23:00 — still the user's pick.
    expect(
      resolveEffectiveAvailability({
        manualStatus: "busy",
        manualMessage: null,
        manualSource: "manual",
        overrideUntil: until,
        schedule: alwaysOpen,
        nowMs: at(2026, 7, 22, 23),
      }).status,
    ).toBe("busy");
    // 00:30 the next day — the schedule has it back.
    expect(
      resolveEffectiveAvailability({
        manualStatus: "busy",
        manualMessage: null,
        manualSource: "manual",
        overrideUntil: until,
        schedule: alwaysOpen,
        nowMs: at(2026, 7, 23, 0) + 30 * 60 * 1000,
      }).status,
    ).toBe("available");
  });

  test("re-anchoring: a shortened shift pulls a live override's expiry IN", () => {
    // The invariant an override must never break: it cannot outlive the shift.
    // A pick at 14:00 under 09:00–17:00 expires at 17:00…
    expect(overrideExpiryFor(nineToFive, at(2026, 7, 22, 14))?.getTime()).toBe(
      at(2026, 7, 22, 17),
    );
    // …and if the schedule is then changed to end at 15:00, re-anchoring
    // against the NEW schedule must move the expiry earlier, not leave it
    // pointing at a boundary that no longer exists.
    const shortened: WorkHours = {
      timezone: BEIRUT,
      weekly: { wed: [{ open: "09:00", close: "15:00" }] },
    };
    expect(overrideExpiryFor(shortened, at(2026, 7, 22, 14))?.getTime()).toBe(
      at(2026, 7, 22, 15),
    );
  });
});
