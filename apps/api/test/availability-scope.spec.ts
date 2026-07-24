import { describe, expect, it } from "vitest";

import { loadAvailabilityScope, resolveUserSchedule } from "@/lib/availability/schedule";
import type { WorkHours } from "@ccp/shared/work-hours";

/**
 * WHICH schedule drives one person's availability, and WHO hears about it.
 *
 * Availability is a property of the PERSON: the columns live on `User`, there is
 * one green dot, and "back at 3pm" is true of a human rather than of an inbox.
 * But `Workspace.workHours` — the thing `workHoursMode: "inherit"` inherits — is
 * per-workspace. A member of two workspaces therefore had TWO schedules writing
 * ONE column, and the sweeper (which looped workspace × member) resolved them in
 * turn: with a 09:00–17:00 workspace and a 17:00–01:00 one that is a status
 * flip, a socket frame and a session-cache bust every 60 seconds, settling on
 * whichever workspace happened to sort last. Downstream, `eligibility:
 * available_only` then dropped the person from routing in the workspace they
 * were actually on shift for.
 *
 * `loadAvailabilityScope` is the single answer. Everything here is about the two
 * things it has to get right at once: exactly ONE governing schedule, and EVERY
 * workspace told about the result.
 */

/** A real, non-empty schedule. `open` is used as the fingerprint so a test can
 *  tell WHICH grid came back. */
const grid = (openAt: string): WorkHours => ({
  timezone: "UTC",
  weekly: { mon: [{ open: openAt, close: "17:00" }] },
  exceptions: [],
});

/** A grid that parses but contains no usable window — an unfinished edit.
 *  `isScheduleEmpty` treats this as "no schedule", deliberately. */
const BLANK: WorkHours = { timezone: "UTC", weekly: {}, exceptions: [] };

/** Stand-in for the `workspaceMember` delegate, honouring `orderBy createdAt asc`. */
function fakeDb(rows: { workspaceId: string; workHours: unknown }[]) {
  return {
    workspaceMember: {
      findMany: async () =>
        rows.map((r) => ({
          workspaceId: r.workspaceId,
          workspace: { workHours: r.workHours },
        })),
    },
  } as unknown as Parameters<typeof loadAvailabilityScope>[0];
}

describe("which workspace's default schedule governs", () => {
  it("skips workspaces with NO schedule and takes the first that has one", async () => {
    // THE REGRESSION. Taking `memberships[0]` unconditionally is equally
    // deterministic and quietly wrong: an admin fills in the working-hours grid
    // on the workspace they are standing in, and nothing happens — because the
    // person's older, schedule-less workspace won the tie. Caught by an E2E
    // timeout, pinned here.
    const scope = await loadAvailabilityScope(
      fakeDb([
        { workspaceId: "ws_old", workHours: null },
        { workspaceId: "ws_configured", workHours: grid("09:01") },
      ]),
      "u1",
    );
    expect(scope.teamSchedule).not.toBeNull();
    expect(scope.teamSchedule?.weekly.mon?.[0]?.open).toBe("09:01");
  });

  it("treats a BLANK grid as no schedule", async () => {
    // A half-filled or emptied grid is an unfinished edit, not an opt-out
    // ("off" is the opt-out) — it must not shadow a real schedule further down.
    const scope = await loadAvailabilityScope(
      fakeDb([
        { workspaceId: "ws_blank", workHours: BLANK },
        { workspaceId: "ws_configured", workHours: grid("09:01") },
      ]),
      "u1",
    );
    expect(scope.teamSchedule?.weekly.mon?.[0]?.open).toBe("09:01");
  });

  it("picks exactly ONE when several workspaces have real schedules", async () => {
    // The flip-flop guard. Two genuine schedules must still yield a single
    // stable answer — join order is the tie-break — rather than each writing the
    // shared column in turn.
    const scope = await loadAvailabilityScope(
      fakeDb([
        { workspaceId: "ws_first", workHours: grid("08:00") },
        { workspaceId: "ws_second", workHours: grid("14:00") },
      ]),
      "u1",
    );
    expect(scope.teamSchedule?.weekly.mon?.[0]?.open).toBe("08:00");
  });

  it("is null when nobody configured hours — availability stays purely manual", async () => {
    const scope = await loadAvailabilityScope(
      fakeDb([
        { workspaceId: "ws_a", workHours: null },
        { workspaceId: "ws_b", workHours: null },
      ]),
      "u1",
    );
    expect(scope.teamSchedule).toBeNull();
  });
});

describe("who gets told", () => {
  it("EVERY workspace the person belongs to, not just the governing one", async () => {
    // `user.availability_changed` is workspace-scoped (each workspace's agents
    // sit in their own `ws:` room and their client drops frames whose
    // workspaceId isn't theirs). Announcing to one workspace left a member of
    // two with a live dot in whichever workspace triggered the write and a
    // permanently stale one in the other.
    const scope = await loadAvailabilityScope(
      fakeDb([
        { workspaceId: "ws_a", workHours: grid("09:00") },
        { workspaceId: "ws_b", workHours: null },
      ]),
      "u1",
    );
    expect(scope.workspaceIds).toEqual(["ws_a", "ws_b"]);
  });

  it("is empty for someone with no memberships, so callers can skip the write", async () => {
    const scope = await loadAvailabilityScope(fakeDb([]), "u1");
    expect(scope.workspaceIds).toEqual([]);
    expect(scope.teamSchedule).toBeNull();
  });
});

describe("the per-user override on top", () => {
  it("a custom grid beats the workspace default", async () => {
    expect(
      resolveUserSchedule({ workHoursMode: "custom", workHours: grid("06:00") }, grid("09:00"))
        ?.weekly.mon?.[0]?.open,
    ).toBe("06:00");
  });

  it("`off` means no schedule at all, even when the workspace has one", async () => {
    expect(resolveUserSchedule({ workHoursMode: "off" }, grid("09:00"))).toBeNull();
  });

  it("an EMPTY custom grid falls back to the workspace default, not to nothing", async () => {
    // An unfinished edit must not silently mark someone away forever.
    expect(
      resolveUserSchedule({ workHoursMode: "custom", workHours: BLANK }, grid("09:00"))
        ?.weekly.mon?.[0]?.open,
    ).toBe("09:00");
  });
});
