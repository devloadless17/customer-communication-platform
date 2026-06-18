import { test, expect } from "@playwright/test";

import { chooseRoundRobin } from "../../../apps/api/src/lib/conversations/round-robin";

/**
 * Round-robin selection rules (pure `chooseRoundRobin`). Covers the prod bug
 * (a status-"available" but disconnected teammate was picked over an online
 * one), plus least-busy distribution and fair rotation.
 */

const M = (id: string, availabilityStatus: string | null = "available") => ({ id, availabilityStatus });
const counts = (o: Record<string, number> = {}) => new Map(Object.entries(o));

test.describe("chooseRoundRobin", () => {
  test("online + available beats a status-available but DISCONNECTED teammate (the prod bug)", () => {
    const members = [M("a"), M("b")]; // both availabilityStatus "available"
    // Only A is actually connected (B closed the browser without flipping status).
    const picked = chooseRoundRobin({
      members,
      onlineUserIds: new Set(["a"]),
      openCounts: counts(),
      cursor: null,
    });
    expect(picked).toBe("a");
  });

  test("falls back to status-available when NOBODY eligible is connected", () => {
    const members = [M("a"), M("b")];
    const picked = chooseRoundRobin({
      members,
      onlineUserIds: new Set(), // no one connected
      openCounts: counts(),
      cursor: null,
    });
    expect(["a", "b"]).toContain(picked); // status-available tier
  });

  test("presence unknown (null) → status-available only", () => {
    const picked = chooseRoundRobin({
      members: [M("a"), M("b")],
      onlineUserIds: null,
      openCounts: counts({ a: 3 }),
      cursor: null,
    });
    expect(picked).toBe("b"); // least-busy
  });

  test("picks the least-busy among online + available", () => {
    const picked = chooseRoundRobin({
      members: [M("a"), M("b"), M("c")],
      onlineUserIds: new Set(["a", "b", "c"]),
      openCounts: counts({ a: 2, b: 0, c: 5 }),
      cursor: null,
    });
    expect(picked).toBe("b");
  });

  test("rotates fairly among equally-loaded candidates", () => {
    const members = [M("a"), M("b"), M("c")];
    const online = new Set(["a", "b", "c"]);
    const zero = counts();
    expect(chooseRoundRobin({ members, onlineUserIds: online, openCounts: zero, cursor: null })).toBe("a");
    expect(chooseRoundRobin({ members, onlineUserIds: online, openCounts: zero, cursor: "a" })).toBe("b");
    expect(chooseRoundRobin({ members, onlineUserIds: online, openCounts: zero, cursor: "b" })).toBe("c");
    expect(chooseRoundRobin({ members, onlineUserIds: online, openCounts: zero, cursor: "c" })).toBe("a"); // wrap
  });

  test("excludes non-available statuses (offline/busy/away) from the available tiers", () => {
    const members = [M("a", "offline"), M("b", "busy"), M("c", "available")];
    const picked = chooseRoundRobin({
      members,
      onlineUserIds: new Set(["a", "b", "c"]),
      openCounts: counts(),
      cursor: null,
    });
    expect(picked).toBe("c");
  });

  test("last resort: when nobody is available at all, still picks an active member", () => {
    const members = [M("a", "offline"), M("b", "busy")];
    const picked = chooseRoundRobin({
      members,
      onlineUserIds: new Set(),
      openCounts: counts(),
      cursor: null,
    });
    expect(["a", "b"]).toContain(picked);
  });

  test("no members → null", () => {
    expect(chooseRoundRobin({ members: [], onlineUserIds: null, openCounts: counts(), cursor: null })).toBeNull();
  });
});
