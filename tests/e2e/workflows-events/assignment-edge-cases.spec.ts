import { test, expect } from "@playwright/test";
import { selectAssignee } from "../../../apps/api/src/lib/assignment/select";

const m = (id: string, over: Record<string, unknown> = {}) => ({
  id, role: "agent", availabilityStatus: "available",
  openCount: 0, weight: 1, served: 0, maxOpen: null, enabled: true, ...over,
});
const P = (over: Record<string, unknown> = {}) => ({
  strategy: "least_busy", eligibility: "any", eligibleRoles: ["agent"],
  includeAllMembers: true, defaultMaxOpen: null, overflow: "leave_unassigned",
  fallbackUserId: null, fixedUserId: null, cursorUserId: null,
  preferPreviousAgent: false, previousAgentWindowDays: 30, ...over,
});
const run = (policy: unknown, members: unknown[], extra: Record<string, unknown> = {}) =>
  selectAssignee({ policy, members, onlineUserIds: new Set<string>(), ...extra } as never);

test.describe("adversarial combinations", () => {
  test("A1 online_only + nobody online → NOBODY (never a bad assign)", () => {
    const r = run(P({ eligibility: "online_only" }), [m("a"), m("b")]);
    expect(r.userId).toBeNull();
  });

  test("A2 available_only + everyone away → NOBODY", () => {
    const r = run(P({ eligibility: "available_only" }),
      [m("a", { availabilityStatus: "away" }), m("b", { availabilityStatus: "busy" })]);
    expect(r.userId).toBeNull();
  });

  test("A3 eligibleRoles excludes everyone → NOBODY, not a crash", () => {
    const r = run(P({ eligibleRoles: ["manager"] }), [m("a"), m("b")]);
    expect(r.userId).toBeNull();
  });

  test("A4 includeAllMembers=false with no enabled roster → NOBODY", () => {
    const r = run(P({ includeAllMembers: false }),
      [m("a", { enabled: false }), m("b", { enabled: false })]);
    expect(r.userId).toBeNull();
  });

  test("A5 capacity full + overflow=leave_unassigned → NOBODY", () => {
    const r = run(P({ defaultMaxOpen: 2 }), [m("a", { openCount: 2 }), m("b", { openCount: 5 })]);
    expect(r.userId).toBeNull();
  });

  test("B1 capacity full + overflow=ignore_capacity → the LEAST loaded, not random", () => {
    const r = run(P({ defaultMaxOpen: 2, overflow: "ignore_capacity" }),
      [m("a", { openCount: 9 }), m("b", { openCount: 3 })]);
    expect(r.userId).toBe("b");
  });

  test("B2 overflow=fallback_user routes to the supervisor", () => {
    const r = run(P({ defaultMaxOpen: 1, overflow: "fallback_user", fallbackUserId: "sup" }),
      [m("a", { openCount: 5 }), m("sup", { openCount: 99 })]);
    expect(r.userId).toBe("sup");
  });

  test("B3 fallback_user pointing at a DEPARTED member → nobody, not a ghost id", () => {
    const r = run(P({ defaultMaxOpen: 1, overflow: "fallback_user", fallbackUserId: "ghost" }),
      [m("a", { openCount: 5 })]);
    expect(r.userId).toBeNull();
  });

  test("C1 continuity NEVER overrides online_only when the previous agent is offline", () => {
    const r = run(P({ eligibility: "online_only", preferPreviousAgent: true }),
      [m("ali"), m("sara")], { previousUserId: "ali", onlineUserIds: new Set(["sara"]) });
    expect(r.userId).toBe("sara");
  });

  test("C2 continuity + capacity: full previous agent yields to a free teammate", () => {
    const r = run(P({ defaultMaxOpen: 2, preferPreviousAgent: true }),
      [m("ali", { openCount: 2 }), m("sara", { openCount: 0 })], { previousUserId: "ali" });
    expect(r.userId).toBe("sara");
  });

  test("C3 continuity respects exclusion (rebalancing OFF that agent)", () => {
    const r = run(P({ preferPreviousAgent: true }), [m("ali"), m("sara")],
      { previousUserId: "ali", excludeUserIds: ["ali"] });
    expect(r.userId).toBe("sara");
  });

  test("D1 every member deactivated/disabled → NOBODY", () => {
    const r = run(P({ includeAllMembers: false }), []);
    expect(r.userId).toBeNull();
  });

  test("D2 no members at all → NOBODY, no throw", () => {
    const r = run(P(), []);
    expect(r.userId).toBeNull();
  });

  test("D3 fixed strategy + the fixed user excluded → overflow, never the excluded one", () => {
    const r = run(P({ strategy: "fixed", fixedUserId: "a", overflow: "leave_unassigned" }),
      [m("a"), m("b")], { excludeUserIds: ["a"] });
    expect(r.userId).not.toBe("a");
  });

  test("E1 weighted 0-weight member is never picked even when idle", () => {
    const r = run(P({ strategy: "weighted" }),
      [m("zero", { weight: 0 }), m("one", { weight: 1, served: 99 })]);
    expect(r.userId).toBe("one");
  });

  test("E2 round_robin cursor at a DEPARTED member restarts cleanly", () => {
    const r = run(P({ strategy: "round_robin", cursorUserId: "ghost" }), [m("a"), m("b")]);
    expect(["a", "b"]).toContain(r.userId);
  });
});
