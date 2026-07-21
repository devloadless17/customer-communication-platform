import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

import { Prisma } from "@prisma/client";

import { APP_ADMIN_EMAIL, appAdmin, db } from "./_helpers/db";
import { DAY_KEYS, type WorkHours } from "../../packages/shared/src/work-hours";

/**
 * Working-hours-driven availability, end to end through the real UI + API.
 *
 * The pure schedule math lives in `workflows-events/work-hours.spec.ts`; this
 * file covers what only a running stack can prove:
 *   - the org working-hours card saves and immediately re-resolves every member
 *   - an off-shift member actually flips to away with an explanatory note
 *   - a manual pick outranks the schedule and expires at the shift boundary
 *   - "follow schedule" hands control straight back
 *   - the admin-for-teammate routes work and are capability-gated
 *   - /v1 parity (read fields + both write routes)
 *
 * Non-destructive by construction: it only touches the acting admin's own
 * availability columns and the team's `workHours`, and restores both in
 * `afterAll` — no `deleteMany`, no fixture wipes.
 */

const TZ = "UTC"; // deterministic regardless of the box's zone

/**
 * Open 24/7 — `close === open` means the window runs to the next midnight, and
 * consecutive days chain, so this schedule NEVER closes. Used where a test just
 * needs "on shift"; it deliberately has no boundary (see the unit spec).
 */
const ALWAYS_OPEN: WorkHours = {
  timezone: TZ,
  weekly: Object.fromEntries(DAY_KEYS.map((d) => [d, [{ open: "00:00", close: "00:00" }]])),
};

/**
 * On shift now AND with a real boundary later today (23:59 UTC) — the fixture
 * for anything asserting an override expiry. (A 24/7 grid has no boundary at
 * all, so it can't exercise expiry.) The one-minute 23:59→00:00 gap each day is
 * the only window in which this reads as off-shift; tests that care assert a
 * bounded expiry rather than an exact status.
 */
const OPEN_WITH_BOUNDARY: WorkHours = {
  timezone: TZ,
  weekly: Object.fromEntries(DAY_KEYS.map((d) => [d, [{ open: "00:00", close: "23:59" }]])),
};

/**
 * A schedule that is definitely CLOSED right now: one short window on a
 * weekday two days out, so neither today's nor yesterday's (overnight) windows
 * can be in force.
 */
function alwaysClosedNow(): WorkHours {
  const todayIdx = (new Date().getUTCDay() + 6) % 7; // DAY_KEYS is Monday-first
  const farDay = DAY_KEYS[(todayIdx + 2) % 7]!;
  return { timezone: TZ, weekly: { [farDay]: [{ open: "09:00", close: "10:00" }] } };
}

async function setTeamWorkHours(request: APIRequestContext, workHours: WorkHours | null) {
  const res = await request.put("/api/team/work-hours", { data: { workHours } });
  expect(res.status(), await res.text()).toBe(200);
}

/** The acting admin's own availability row, straight from the DB. */
async function myRow(userId: string) {
  return db().user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      availabilityStatus: true,
      availabilityMessage: true,
      availabilityManualStatus: true,
      availabilityManualMessage: true,
      availabilitySource: true,
      availabilitySetByUserId: true,
      availabilityOverrideUntil: true,
    },
  });
}

let adminUserId: string;
let adminTeamId: string;

test.beforeAll(async () => {
  const { teamId, userId } = await appAdmin();
  adminTeamId = teamId;
  adminUserId = userId;
});

test.afterAll(async () => {
  // Restore: no org schedule, a clean manual availability row.
  await db().team.update({ where: { id: adminTeamId }, data: { workHours: Prisma.DbNull } });
  await db().user.updateMany({
    where: { teamId: adminTeamId },
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

test.describe("working hours → availability", () => {
  test("no schedule → a manual pick persists indefinitely (pre-feature behavior)", async ({
    request,
  }) => {
    await setTeamWorkHours(request, null);

    const res = await request.patch("/api/users/me/availability", {
      data: { status: "busy", message: "Heads down" },
    });
    expect(res.status(), await res.text()).toBe(200);

    const row = await myRow(adminUserId);
    expect(row.availabilityStatus).toBe("busy");
    expect(row.availabilityMessage).toBe("Heads down");
    // The critical regression guard: with no schedule there is nothing to
    // expire back to, so the pick must NOT get an expiry.
    expect(row.availabilityOverrideUntil).toBeNull();
    expect(row.availabilitySource).toBe("manual");
  });

  test("turning on an OFF-SHIFT org schedule flips members to away immediately", async ({
    request,
  }) => {
    await setTeamWorkHours(request, alwaysClosedNow());

    // The route re-resolves every member on save — no waiting for the 60s tick.
    const row = await myRow(adminUserId);
    expect(row.availabilityStatus).toBe("away");
    expect(row.availabilityMessage).toContain("Outside working hours");
    expect(row.availabilitySource).toBe("schedule");
    // The user's own pick from the previous test survives underneath.
    expect(row.availabilityManualStatus).toBe("busy");
    expect(row.availabilityManualMessage).toBe("Heads down");
  });

  test("an ON-SHIFT schedule brings them back to available and drops the stale note", async ({
    request,
  }) => {
    await setTeamWorkHours(request, ALWAYS_OPEN);

    const row = await myRow(adminUserId);
    expect(row.availabilityStatus).toBe("available");
    expect(row.availabilityMessage).toBeNull();
    expect(row.availabilitySource).toBe("schedule");
  });

  test("a manual pick outranks the schedule and expires at the shift boundary", async ({
    request,
  }) => {
    await setTeamWorkHours(request, OPEN_WITH_BOUNDARY);

    const res = await request.patch("/api/users/me/availability", {
      data: { status: "away", message: "Lunch" },
    });
    expect(res.status()).toBe(200);

    const row = await myRow(adminUserId);
    expect(row.availabilityStatus).toBe("away");
    expect(row.availabilityMessage).toBe("Lunch");
    expect(row.availabilitySource).toBe("manual");
    // THE feature: the override carries an expiry, in the future but within a
    // day — it cannot outlive the shift that motivated it.
    expect(row.availabilityOverrideUntil).not.toBeNull();
    const untilMs = row.availabilityOverrideUntil!.getTime();
    expect(untilMs).toBeGreaterThan(Date.now());
    expect(untilMs).toBeLessThanOrEqual(Date.now() + 25 * 60 * 60 * 1000);
  });

  test("a 24/7 schedule has no boundary, so a pick expires at local midnight", async ({
    request,
  }) => {
    await setTeamWorkHours(request, ALWAYS_OPEN);
    const res = await request.patch("/api/users/me/availability", {
      data: { status: "busy" },
    });
    expect(res.status()).toBe(200);

    const row = await myRow(adminUserId);
    // The pick has to STICK (a null expiry would mean "no override", letting
    // the schedule reclaim the status instantly — a 24/7 team could then never
    // mark themselves busy at all)…
    expect(row.availabilityStatus).toBe("busy");
    expect(row.availabilityOverrideUntil).not.toBeNull();
    // …and it still has to be BOUNDED: midnight, so it can't outlive the day.
    const untilMs = row.availabilityOverrideUntil!.getTime();
    expect(untilMs).toBeGreaterThan(Date.now());
    expect(untilMs).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000 + 1000);
    expect(new Date(untilMs).getUTCHours()).toBe(0);
    expect(new Date(untilMs).getUTCMinutes()).toBe(0);
  });

  test("changing the schedule RE-ANCHORS a live override to the new boundary", async ({
    request,
  }) => {
    await setTeamWorkHours(request, OPEN_WITH_BOUNDARY);
    await request.patch("/api/users/me/availability", { data: { status: "busy" } });
    const before = await myRow(adminUserId);
    expect(before.availabilityOverrideUntil).not.toBeNull();

    // Shorten the day dramatically: the old expiry (23:59) now points at a
    // boundary that no longer exists. Without re-anchoring the override would
    // outlive the new shift — the one thing this feature must never allow.
    const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
    const closeMin = Math.min(nowMin + 30, 23 * 60 + 59);
    const close = `${String(Math.floor(closeMin / 60)).padStart(2, "0")}:${String(
      closeMin % 60,
    ).padStart(2, "0")}`;
    await setTeamWorkHours(request, {
      timezone: TZ,
      weekly: Object.fromEntries(DAY_KEYS.map((d) => [d, [{ open: "00:00", close }]])),
    });

    const after = await myRow(adminUserId);
    expect(after.availabilityOverrideUntil).not.toBeNull();
    // Re-anchored: strictly earlier than the old 23:59 boundary (unless the run
    // is already inside the last 30 minutes of the day, where they coincide).
    expect(after.availabilityOverrideUntil!.getTime()).toBeLessThanOrEqual(
      before.availabilityOverrideUntil!.getTime(),
    );
    expect(after.availabilityOverrideUntil!.getTime()).toBeLessThanOrEqual(
      Date.now() + 31 * 60 * 1000,
    );
  });

  test("followSchedule hands control straight back to the schedule", async ({ request }) => {
    const res = await request.patch("/api/users/me/availability", {
      data: { followSchedule: true },
    });
    expect(res.status(), await res.text()).toBe(200);

    const row = await myRow(adminUserId);
    expect(row.availabilityOverrideUntil).toBeNull();
    expect(row.availabilitySource).toBe("schedule");
    expect(row.availabilityStatus).toBe("available"); // ALWAYS_OPEN is on shift
  });

  test("followSchedule can't be combined with a status (contradictory body → 400)", async ({
    request,
  }) => {
    const res = await request.patch("/api/users/me/availability", {
      data: { followSchedule: true, status: "busy" },
    });
    expect(res.status()).toBe(400);
  });

  test("a malformed schedule is rejected before it can mark anyone away", async ({
    request,
  }) => {
    const bad = await request.put("/api/team/work-hours", {
      data: { workHours: { timezone: "Not/AZone", weekly: { mon: [{ open: "09:00", close: "17:00" }] } } },
    });
    expect(bad.status()).toBe(400);

    const badTime = await request.put("/api/team/work-hours", {
      data: { workHours: { timezone: TZ, weekly: { mon: [{ open: "9am", close: "17:00" }] } } },
    });
    expect(badTime.status()).toBe(400);
  });

  test("a BLANK grid is stored but treated as no schedule — nobody is marked away", async ({
    request,
  }) => {
    await setTeamWorkHours(request, { timezone: TZ, weekly: {} });

    const row = await myRow(adminUserId);
    // The safety rule: an empty grid must not park the whole org on "away".
    expect(row.availabilityStatus).not.toBe("away");
    expect(row.availabilityOverrideUntil).toBeNull();
  });
});

test.describe("admin acting for a teammate", () => {
  /** A disposable second member — the admin routes must target someone ELSE. */
  let mateId: string;

  test.beforeAll(async () => {
    const mate = await db().user.create({
      data: {
        teamId: adminTeamId,
        name: "Shift Mate",
        email: `wh-mate-${Date.now()}@loadless.test`,
        role: "agent",
      },
      select: { id: true },
    });
    mateId = mate.id;
  });

  test.afterAll(async () => {
    await db().user.delete({ where: { id: mateId } }).catch(() => undefined);
  });

  const mateRow = () =>
    db().user.findUniqueOrThrow({
      where: { id: mateId },
      select: {
        availabilityStatus: true,
        availabilityMessage: true,
        availabilitySource: true,
        availabilitySetByUserId: true,
        availabilityOverrideUntil: true,
        workHoursMode: true,
      },
    });

  test("sets a TEAMMATE's status, attributes it, then resets them to the schedule", async ({
    request,
  }) => {
    await setTeamWorkHours(request, ALWAYS_OPEN);

    const set = await request.patch(`/api/users/${mateId}/availability`, {
      data: { status: "offline", message: "Left for the day" },
    });
    expect(set.status(), await set.text()).toBe(200);

    const row = await mateRow();
    expect(row.availabilityStatus).toBe("offline");
    expect(row.availabilitySource).toBe("admin");
    expect(row.availabilitySetByUserId).toBe(adminUserId);

    const reset = await request.patch(`/api/users/${mateId}/availability`, {
      data: { followSchedule: true },
    });
    expect(reset.status()).toBe(200);

    const after = await mateRow();
    expect(after.availabilitySource).toBe("schedule");
    // Attribution must NOT survive the reset — otherwise a later reader
    // renders "set by <admin>" next to a status the admin didn't set.
    expect(after.availabilitySetByUserId).toBeNull();
  });

  test("a user setting their OWN status via the admin route stays 'manual'", async ({
    request,
  }) => {
    await setTeamWorkHours(request, null);
    const res = await request.patch(`/api/users/${adminUserId}/availability`, {
      data: { status: "busy" },
    });
    expect(res.status()).toBe(200);
    // Provenance follows WHO acted, not which route was used — an admin
    // adjusting their own status is a personal pick, and rendering "set by an
    // admin" on their own row would be nonsense.
    const row = await myRow(adminUserId);
    expect(row.availabilitySource).toBe("manual");
    expect(row.availabilitySetByUserId).toBeNull();
  });

  test("per-member working hours: custom → off → inherit", async ({ request }) => {
    await setTeamWorkHours(request, ALWAYS_OPEN);

    // A custom OFF-SHIFT schedule overrides the org's always-open one.
    const custom = await request.put(`/api/users/${mateId}/work-hours`, {
      data: { mode: "custom", workHours: alwaysClosedNow() },
    });
    expect(custom.status(), await custom.text()).toBe(200);
    expect((await mateRow()).availabilityStatus).toBe("away");

    // `off` opts out of scheduling entirely — availability goes back to manual.
    const off = await request.put(`/api/users/${mateId}/work-hours`, {
      data: { mode: "off" },
    });
    expect(off.status()).toBe(200);
    const offRow = await mateRow();
    expect(offRow.availabilitySource).toBe("manual");
    expect(offRow.availabilityOverrideUntil).toBeNull();

    // Back to inheriting the org's always-open schedule.
    const inherit = await request.put(`/api/users/${mateId}/work-hours`, {
      data: { mode: "inherit" },
    });
    expect(inherit.status()).toBe(200);
    expect((await mateRow()).availabilityStatus).toBe("available");

    // Switching away from `custom` KEEPS their grid on file, so flipping back
    // doesn't lose the week someone filled in.
    const kept = await db().user.findUniqueOrThrow({
      where: { id: mateId },
      select: { workHours: true },
    });
    expect(kept.workHours).not.toBeNull();

    // `custom` without a schedule is a contradiction, not a silent drop.
    const bad = await request.put(`/api/users/${mateId}/work-hours`, {
      data: { mode: "custom" },
    });
    expect(bad.status()).toBe(400);
  });

  test("a deactivated member is left alone by the schedule", async ({ request }) => {
    await db().user.update({
      where: { id: mateId },
      data: { deactivatedAt: new Date(), availabilityStatus: "available" },
    });
    // An off-shift org schedule re-resolves the team…
    await setTeamWorkHours(request, alwaysClosedNow());
    // …but a disabled account isn't a member of the rota; touching it would
    // churn rows (and frames) for someone who can't sign in.
    expect((await mateRow()).availabilityStatus).toBe("available");
    await db().user.update({ where: { id: mateId }, data: { deactivatedAt: null } });
  });

  test("cross-tenant: a member of another team is a 404, never a mutation", async ({
    request,
  }) => {
    const foreign = await db().user.findFirst({
      where: { teamId: { not: adminTeamId } },
      select: { id: true, availabilityStatus: true },
    });
    test.skip(!foreign, "no second team in this dev DB");

    const res = await request.patch(`/api/users/${foreign!.id}/availability`, {
      data: { status: "busy" },
    });
    expect(res.status()).toBe(404);
    const hours = await request.put(`/api/users/${foreign!.id}/work-hours`, {
      data: { mode: "off" },
    });
    expect(hours.status()).toBe(404);

    // And nothing was written to them.
    const after = await db().user.findUniqueOrThrow({
      where: { id: foreign!.id },
      select: { availabilityStatus: true },
    });
    expect(after.availabilityStatus).toBe(foreign!.availabilityStatus);
  });

  test("agents don't get the capability by default; managers do", async () => {
    const { DEFAULT_CAPABILITIES } = await import(
      "../../packages/shared/src/auth/permissions"
    );
    expect(DEFAULT_CAPABILITIES.agent["availability:manageOthers"]).toBe(false);
    expect(DEFAULT_CAPABILITIES.manager["availability:manageOthers"]).toBe(true);
    // Self-service availability stays on for agents — this feature must not
    // quietly take away the toggle they already had.
    expect(DEFAULT_CAPABILITIES.agent["availability:manage"]).toBe(true);
  });
});

test.describe("Settings → Team UI", () => {
  /**
   * Fail on a real client error rather than letting Next's dev overlay quietly
   * swallow it — and hide that overlay, which otherwise sits on top of the page
   * and intercepts clicks (dev-only chrome, absent in a prod build).
   */
  function guard(page: Page): string[] {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push("uncaught: " + String(e)));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      // Resource 404s are routine here (the avatar route 404s BY DESIGN for a
      // member with no avatar), and they aren't what we're guarding against —
      // an uncaught exception or a React error is.
      if (/Failed to load resource/.test(m.text())) return;
      errors.push(m.text());
    });
    return errors;
  }

  /**
   * Next's dev overlay/indicator renders bottom-left — exactly where the
   * account-menu button lives — and swallows the click. Dev-only chrome that
   * doesn't exist in a prod build, so hiding it is fidelity-neutral. Must run
   * AFTER navigation (`addInitScript` fires before `documentElement` exists).
   */
  async function hideDevChrome(page: Page): Promise<void> {
    await page.addStyleTag({ content: "nextjs-portal{display:none !important}" });
  }

  test("the org working-hours card saves a schedule and reflects member state", async ({
    page,
    request,
  }) => {
    const errors = guard(page);
    await setTeamWorkHours(request, null);
    await page.goto("/settings/team");
    await hideDevChrome(page);

    await expect(page.getByText("Working hours", { exact: true })).toBeVisible();

    // Enabling reveals the grid (it does NOT save yet — the admin reviews the
    // Mon–Fri default before it starts moving people around).
    await page.getByLabel("Enable org working hours").click();
    await expect(page.getByLabel("Schedule timezone")).toBeVisible();
    await expect(page.getByRole("button", { name: /Copy Monday to Tue–Fri/ })).toBeVisible();

    // Nothing persisted on the toggle alone.
    const beforeSave = await db().team.findUniqueOrThrow({
      where: { id: adminTeamId },
      select: { workHours: true },
    });
    expect(beforeSave.workHours).toBeNull();

    await page.getByLabel("Schedule timezone").selectOption("UTC");
    await page.getByRole("button", { name: /Save working hours/ }).click();
    await expect(page.getByText(/Working hours saved/)).toBeVisible({ timeout: 15_000 });

    const saved = await db().team.findUniqueOrThrow({
      where: { id: adminTeamId },
      select: { workHours: true },
    });
    expect(saved.workHours).not.toBeNull();
    expect((saved.workHours as { timezone: string }).timezone).toBe("UTC");
    // Saving re-resolves every member — the default grid has real weekdays, so
    // each member now carries a schedule-derived status.
    const row = await myRow(adminUserId);
    expect(["available", "away"]).toContain(row.availabilityStatus);
    expect(row.availabilitySource).toBe("schedule");
    expect(errors, "no client errors on the settings page").toEqual([]);
  });

  test("a blank grid warns instead of silently parking the org on away", async ({
    page,
    request,
  }) => {
    guard(page);
    await setTeamWorkHours(request, null);
    await page.goto("/settings/team");
    await hideDevChrome(page);
    await page.getByLabel("Enable org working hours").click();

    // Switch every day off.
    for (const label of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) {
      const sw = page.getByLabel(`${label} working`);
      if ((await sw.getAttribute("aria-checked")) === "true") await sw.click();
    }
    await expect(page.getByText(/this schedule is inactive/)).toBeVisible();
  });

  test("a member row shows their live status, and the menu can set it", async ({
    page,
    request,
  }) => {
    await setTeamWorkHours(request, null);
    await request.patch("/api/users/me/availability", {
      data: { status: "busy", message: "On a call" },
    });

    guard(page);
    await page.goto("/settings/team");
    await hideDevChrome(page);
    // The row surfaces the note next to a status dot.
    await expect(page.getByText("On a call").first()).toBeVisible();

    // Scope to OUR OWN row — the roster is sorted by creation date, so
    // `.first()` would drive whichever teammate happens to sort first and the
    // assertions below would then be checking the wrong person's row.
    const myRowEl = page.locator("li").filter({ hasText: APP_ADMIN_EMAIL });
    await myRowEl.getByRole("button", { name: "Availability" }).click();
    await expect(page.getByRole("menuitem", { name: "Available" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Follow their schedule/ })).toBeVisible();
    await page.getByRole("menuitem", { name: "Available" }).click();

    await expect
      .poll(async () => (await myRow(adminUserId)).availabilityStatus, { timeout: 15_000 })
      .toBe("available");
    const row = await myRow(adminUserId);
    // Going available clears the note — the rule that predates working hours.
    expect(row.availabilityMessage).toBeNull();
    // Still "manual": provenance follows WHO acted, not which control was used.
    // (The admin-for-a-teammate path asserts "admin" on a real second member.)
    expect(row.availabilitySource).toBe("manual");
  });

  test("a teammate with NO live socket reads as Offline, not their stored status", async ({
    page,
    request,
  }) => {
    // The bug this guards, seen in prod: the members list painted the STORED
    // availability with no presence check, so someone who wasn't connected at
    // all still showed a green "Available" here while the inbox sidebar
    // correctly showed them grey. Two surfaces, same person, opposite answers.
    guard(page);
    await setTeamWorkHours(request, null);
    const ghost = await db().user.create({
      data: {
        teamId: adminTeamId,
        name: `Ghost ${Date.now()}`,
        email: `wh-ghost-${Date.now()}@loadless.test`,
        role: "agent",
        availabilityStatus: "available",
        availabilityManualStatus: "available",
      },
      select: { id: true, name: true },
    });
    try {
      await request.patch("/api/users/me/availability", { data: { status: "available" } });
      await page.goto("/settings/team");
      await hideDevChrome(page);

      const ghostRow = page.locator("li").filter({ hasText: ghost.name });
      await expect(ghostRow).toBeVisible();
      // Never connected -> Offline, regardless of the row's stored status.
      await expect(ghostRow.getByTitle("Offline")).toBeVisible();
      await expect(ghostRow.getByTitle("Available")).toHaveCount(0);

      // ...while OUR row (this browser holds a live socket) reads Available.
      const mine = page.locator("li").filter({ hasText: APP_ADMIN_EMAIL });
      await expect(mine.getByTitle("Available")).toBeVisible();
    } finally {
      await db().user.delete({ where: { id: ghost.id } }).catch(() => undefined);
    }
  });

  test("the account-menu picker shows schedule context and can follow the schedule", async ({
    page,
    request,
  }) => {
    const errors = guard(page);
    await setTeamWorkHours(request, OPEN_WITH_BOUNDARY);
    await page.goto("/inbox");
    await hideDevChrome(page);

    await page.getByLabel("Open account menu").click();
    await expect(page.getByText("Availability")).toBeVisible();
    // On shift with no override → the picker explains itself.
    await expect(page.getByText(/Following your working hours/)).toBeVisible();

    // Picking a status creates an override, which reveals the reset affordance.
    await page.getByRole("button", { name: "Busy" }).click();
    await expect(page.getByRole("button", { name: /Follow schedule/ })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole("button", { name: /Follow schedule/ }).click();
    await expect
      .poll(async () => (await myRow(adminUserId)).availabilityOverrideUntil, {
        timeout: 15_000,
      })
      .toBeNull();
    expect(errors, "no client errors driving the picker").toEqual([]);
  });
});

test.describe("/v1 parity", () => {
  /** A key with the scopes these routes need. */
  async function apiKey(request: APIRequestContext): Promise<string> {
    const res = await request.post("/api/team/api-keys", {
      data: { name: `wh-e2e-${Date.now()}`, scopes: ["read:catalog", "write:users"] },
    });
    expect(res.status(), await res.text()).toBeLessThan(300);
    const body = (await res.json()) as { token?: string; apiKey?: { token?: string } };
    const token = body.token ?? body.apiKey?.token;
    expect(token, "api key token").toBeTruthy();
    return token!;
  }

  test("GET /v1/users exposes availability; the write routes work and are scope-gated", async ({
    request,
    playwright,
  }) => {
    await setTeamWorkHours(request, ALWAYS_OPEN);
    const token = await apiKey(request);
    const v1 = await playwright.request.newContext({
      baseURL: test.info().project.use.baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    const list = await v1.get("/api/external/v1/users");
    expect(list.status(), await list.text()).toBe(200);
    const { items } = (await list.json()) as {
      items: Array<{ id: string; workHoursMode?: string; availabilityStatus?: string }>;
    };
    const me = items.find((u) => u.id === adminUserId);
    expect(me, "acting admin present in /v1/users").toBeTruthy();
    expect(me!.workHoursMode).toBe("inherit");

    // Write: set a status, then hand it back to the schedule.
    const set = await v1.patch(`/api/external/v1/users/${adminUserId}/availability`, {
      data: { status: "busy", message: "via API" },
    });
    expect(set.status(), await set.text()).toBe(200);
    const busy = await myRow(adminUserId);
    expect(busy.availabilityStatus).toBe("busy");
    // An API key has no member identity — the write is "admin" but attributed
    // to nobody, never falsely credited to the target themselves.
    expect(busy.availabilitySource).toBe("admin");
    expect(busy.availabilitySetByUserId).toBeNull();

    // Hand control back first: a LIVE override legitimately outranks a schedule
    // change (that's the point of an override), so asserting the schedule wins
    // while one is in force would be asserting the wrong rule.
    const follow = await v1.patch(`/api/external/v1/users/${adminUserId}/availability`, {
      data: { followSchedule: true },
    });
    expect(follow.status(), await follow.text()).toBe(200);

    const hours = await v1.put(`/api/external/v1/users/${adminUserId}/work-hours`, {
      data: { mode: "custom", workHours: alwaysClosedNow() },
    });
    expect(hours.status(), await hours.text()).toBe(200);
    expect((await myRow(adminUserId)).availabilityStatus).toBe("away");

    // Reads reflect it too — the field partners poll.
    const one = await v1.get(`/api/external/v1/users/${adminUserId}`);
    expect(one.status()).toBe(200);
    const { user } = (await one.json()) as {
      user: { availabilityStatus?: string; availabilitySource?: string; workHoursMode?: string };
    };
    expect(user.availabilityStatus).toBe("away");
    expect(user.availabilitySource).toBe("schedule");
    expect(user.workHoursMode).toBe("custom");

    await v1.dispose();
  });

  test("a key WITHOUT write:users is refused", async ({ request, playwright }) => {
    const res = await request.post("/api/team/api-keys", {
      data: { name: `wh-e2e-noscope-${Date.now()}`, scopes: ["read:catalog"] },
    });
    const body = (await res.json()) as { token?: string; apiKey?: { token?: string } };
    const token = body.token ?? body.apiKey?.token;
    const v1 = await playwright.request.newContext({
      baseURL: test.info().project.use.baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    const denied = await v1.patch(`/api/external/v1/users/${adminUserId}/availability`, {
      data: { status: "busy" },
    });
    expect(denied.status()).toBe(403);
    await v1.dispose();
  });
});
