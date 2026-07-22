import { test, expect } from "@playwright/test";
import { Prisma } from "@prisma/client";

import { appAdmin, db } from "./_helpers/db";
import { DAY_KEYS, type WorkHours } from "../../packages/shared/src/work-hours";

/**
 * The working-hours SWEEPER — the one path nothing else exercises.
 *
 * Everything else in this feature is triggered by a request. The boundary flip
 * is not: an agent who shut their laptop at 17:00 isn't around to trigger a
 * recompute, so a 60s tick is the only thing that moves them. If that tick is
 * broken the whole feature silently does nothing, and no request-driven test
 * would notice.
 *
 * These specs drive real time by planting a schedule whose boundary is a few
 * seconds away, then waiting for the tick.
 *
 * Slow by nature (a tick is 60s), so they carry their own generous timeout and
 * are kept out of the request-driven file.
 */

const TZ = "UTC";
/**
 * How long to wait for the flip: the close time can be up to a minute out
 * (schedules have minute granularity, see `closesSoon`) and the tick runs every
 * 60s, so ~3 minutes is the honest ceiling.
 */
const TICK_WINDOW_MS = 200_000;

test.describe.configure({ mode: "serial", timeout: 420_000 });

/**
 * A schedule that closes SHORTLY BUT STRICTLY IN THE FUTURE, then stays shut.
 *
 * Schedules have minute granularity, so the close time is rounded UP to the
 * next whole minute after `seconds` from now. Truncating instead would
 * intermittently produce a close time in the PAST — the schedule would already
 * be shut when the test set up its "on shift" precondition, and a pick made
 * then would (correctly) run until the next opening, looking like a stuck
 * override.
 */
function closesSoon(seconds: number): { schedule: WorkHours; closesAtMs: number } {
  const target = Date.now() + seconds * 1000;
  const closesAtMs = Math.ceil(target / 60_000) * 60_000;
  const end = new Date(closesAtMs);
  const close = `${String(end.getUTCHours()).padStart(2, "0")}:${String(
    end.getUTCMinutes(),
  ).padStart(2, "0")}`;
  return {
    schedule: {
      timezone: TZ,
      weekly: Object.fromEntries(DAY_KEYS.map((d) => [d, [{ open: "00:00", close }]])),
    },
    closesAtMs,
  };
}

let adminUserId: string;
let adminTeamId: string;

test.beforeAll(async () => {
  const { workspaceId, userId } = await appAdmin();
  adminTeamId = workspaceId;
  adminUserId = userId;
  // Start from a known state. These specs assert a member is ON SHIFT before
  // watching the tick carry them off it, and a live override left behind by an
  // earlier file (the widget suite drives members busy/away) legitimately
  // outranks the schedule — which would make the precondition depend on file
  // ordering rather than on the behavior under test.
  await db().user.updateMany({
    where: { workspaceMemberships: { some: { workspaceId: adminTeamId } } },
    data: {
      availabilityStatus: "available",
      availabilityMessage: null,
      availabilityManualStatus: "available",
      availabilityManualMessage: null,
      availabilitySource: "manual",
      availabilitySetByUserId: null,
      availabilityOverrideUntil: null,
      workHoursMode: "inherit",
      workHours: Prisma.DbNull,
    },
  });
});

test.afterAll(async () => {
  await db().workspace.update({ where: { id: adminTeamId }, data: { workHours: Prisma.DbNull } });
  await db().user.updateMany({
    where: { workspaceMemberships: { some: { workspaceId: adminTeamId } } },
    data: {
      availabilityStatus: "available",
      availabilityMessage: null,
      availabilityManualStatus: "available",
      availabilityManualMessage: null,
      availabilitySource: "manual",
      availabilitySetByUserId: null,
      availabilityOverrideUntil: null,
      workHoursMode: "inherit",
      workHours: Prisma.DbNull,
    },
  });
});

const row = () =>
  db().user.findUniqueOrThrow({
    where: { id: adminUserId },
    select: {
      availabilityStatus: true,
      availabilityMessage: true,
      availabilitySource: true,
      availabilityOverrideUntil: true,
    },
  });

test("the tick carries a member across a shift boundary with nobody watching", async ({
  request,
}) => {
  // On shift now, closing within the next minute or two.
  const { schedule } = closesSoon(20);
  await request.put("/api/team/work-hours", { data: { workHours: schedule } });
  // Drop any override an earlier file left behind: a live one legitimately
  // outranks the schedule, so without this the precondition below depends on
  // test-file ordering rather than on the behavior under test.
  await request.patch("/api/users/me/availability", { data: { followSchedule: true } });
  const before = await row();
  expect(before.availabilityStatus).toBe("available");
  expect(before.availabilitySource).toBe("schedule");

  // No further requests are made — only the sweeper can change this.
  await expect
    .poll(async () => (await row()).availabilityStatus, {
      timeout: TICK_WINDOW_MS,
      intervals: [2_000],
    })
    .toBe("away");

  const after = await row();
  expect(after.availabilityMessage).toContain("Outside working hours");
  expect(after.availabilitySource).toBe("schedule");
});

test("the tick expires a manual override at the boundary and hands back to the schedule", async ({
  request,
}) => {
  // Re-open, then take a manual pick that must not outlive the shift.
  const { schedule, closesAtMs } = closesSoon(30);
  await request.put("/api/team/work-hours", { data: { workHours: schedule } });
  const set = await request.patch("/api/users/me/availability", {
    data: { status: "busy", message: "Wrapping up" },
  });
  expect(set.status()).toBe(200);

  const picked = await row();
  expect(picked.availabilityStatus).toBe("busy");
  // The pick must be anchored to THIS shift's end — proving the precondition
  // (we really were on shift) as well as the anchoring rule.
  expect(picked.availabilityOverrideUntil?.getTime()).toBe(closesAtMs);

  // The whole promise of the feature, on a real clock: the pick dies at the
  // boundary without anyone touching it.
  await expect
    .poll(async () => (await row()).availabilityStatus, {
      timeout: TICK_WINDOW_MS,
      intervals: [2_000],
    })
    .toBe("away");
  expect((await row()).availabilityOverrideUntil).toBeNull();
});

test("the flip reaches connected clients as exactly ONE realtime frame", async ({
  page,
  request,
}) => {
  // Observe the REAL app socket from the browser rather than opening a second
  // client: Playwright surfaces raw frames, and counting them is exactly the
  // guard we want (no duplicate team-room announcements).
  const frames: string[] = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", (f) => {
      const payload = typeof f.payload === "string" ? f.payload : f.payload.toString();
      if (payload.includes("user:availability:updated")) frames.push(payload);
    });
  });

  // Re-open the schedule BEFORE connecting so the settle-flip isn't counted.
  const { schedule } = closesSoon(45);
  await request.put("/api/team/work-hours", { data: { workHours: schedule } });
  await page.goto("/inbox");
  await page.waitForTimeout(3_000);
  frames.length = 0;

  // Now the sweeper closes the shift while the tab watches.
  await expect
    .poll(async () => (await row()).availabilityStatus, {
      timeout: TICK_WINDOW_MS,
      intervals: [2_000],
    })
    .toBe("away");

  // Give another tick a chance to (wrongly) re-emit.
  await page.waitForTimeout(65_000);

  const mine = frames.filter((f) => f.includes(adminUserId) && f.includes('"away"'));
  // Exactly one: `applyAvailability` no-ops when nothing changed, so a member
  // sitting off-shift must NOT be re-announced every 60s for the rest of the
  // night. This is the guard against a slow team-room frame leak.
  expect(mine.length, `frames: ${JSON.stringify(frames)}`).toBe(1);
  expect(mine[0]).toContain("schedule");
});
