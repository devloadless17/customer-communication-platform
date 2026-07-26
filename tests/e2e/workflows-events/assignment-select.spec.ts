import { test, expect } from "@playwright/test";

import {
  selectAssignee,
  type SelectableMember,
  type SelectablePolicy,
} from "../../../apps/api/src/lib/assignment/select";
import {
  matchesConditions,
  parseConditions,
  pickRule,
} from "../../../apps/api/src/lib/assignment/rules";
import {
  apportion,
  parseSplit,
} from "../../../apps/api/src/lib/assignment/broadcast-plan";

/**
 * Assignment engine — pure-function coverage of every routing scenario.
 *
 * These run without a database because the engine was split that way on
 * purpose: `select.ts` / `rules.ts` / `broadcast-plan.ts` take every input as an
 * argument. Anything that needs Prisma lives in `resolve.ts` / `apply.ts` and is
 * covered by the API tests instead.
 *
 * The scenarios below are the inventory of "what could go wrong with
 * assignment" — degenerate teams, mid-flight departures, capacity exhaustion,
 * cold-start fairness, and the two ways a split can fail to add up.
 */

const policy = (over: Partial<SelectablePolicy> = {}): SelectablePolicy => ({
  id: "p1",
  name: "Test",
  strategy: "least_busy",
  eligibility: "online_first",
  eligibleRoles: [],
  includeAllMembers: true,
  defaultMaxOpen: null,
  overflow: "leave_unassigned",
  fallbackUserId: null,
  fixedUserId: null,
  cursorUserId: null,
  preferPreviousAgent: false,
  ...over,
});

const member = (
  id: string,
  over: Partial<SelectableMember> = {},
): SelectableMember => ({
  id,
  role: "agent",
  availabilityStatus: "available",
  openCount: 0,
  hasOverride: false,
  enabled: true,
  weight: 1,
  maxOpen: null,
  served: 0,
  ...over,
});

test.describe("selectAssignee — strategies", () => {
  test("least_busy picks the fewest open conversations", () => {
    const r = selectAssignee({
      policy: policy({ strategy: "least_busy" }),
      members: [member("a", { openCount: 3 }), member("b", { openCount: 1 }), member("c", { openCount: 5 })],
      onlineUserIds: new Set(["a", "b", "c"]),
    });
    expect(r.userId).toBe("b");
    expect(r.reason).toBe("picked");
  });

  test("least_busy breaks equal-load ties by rotating past the cursor", () => {
    const p = policy({ strategy: "least_busy", cursorUserId: "a" });
    const members = [member("a"), member("b"), member("c")];
    expect(selectAssignee({ policy: p, members, onlineUserIds: null }).userId).toBe("b");
  });

  test("round_robin takes turns even when someone is badly overloaded", () => {
    // The whole point of the strict mode: load is IGNORED.
    const p = policy({ strategy: "round_robin", cursorUserId: "a" });
    const members = [member("a", { openCount: 0 }), member("b", { openCount: 99 })];
    expect(selectAssignee({ policy: p, members, onlineUserIds: null }).userId).toBe("b");
  });

  test("round_robin wraps around the end of the list", () => {
    const p = policy({ strategy: "round_robin", cursorUserId: "c" });
    const members = [member("a"), member("b"), member("c")];
    expect(selectAssignee({ policy: p, members, onlineUserIds: null }).userId).toBe("a");
  });

  test("a cursor pointing at someone who LEFT restarts the rotation", () => {
    const p = policy({ strategy: "round_robin", cursorUserId: "gone" });
    const members = [member("a"), member("b")];
    expect(selectAssignee({ policy: p, members, onlineUserIds: null }).userId).toBe("a");
  });

  test("weighted converges to the configured 50/20 ratio", () => {
    // Simulate 70 assignments and check the split is EXACTLY 50/20 — the
    // property a probabilistic picker could not promise.
    const served = { a: 0, b: 0 };
    for (let i = 0; i < 70; i++) {
      const r = selectAssignee({
        policy: policy({ strategy: "weighted" }),
        members: [
          member("a", { hasOverride: true, weight: 50, served: served.a }),
          member("b", { hasOverride: true, weight: 20, served: served.b }),
        ],
        onlineUserIds: null,
      });
      served[r.userId as "a" | "b"] += 1;
    }
    expect(served).toEqual({ a: 50, b: 20 });
  });

  test("weighted excludes a zero-weight member (the documented way to bench someone)", () => {
    const r = selectAssignee({
      policy: policy({ strategy: "weighted" }),
      members: [
        member("a", { hasOverride: true, weight: 0 }),
        member("b", { hasOverride: true, weight: 1 }),
      ],
      onlineUserIds: null,
    });
    expect(r.userId).toBe("b");
  });

  test("weighted with EVERY weight zero assigns nobody instead of dividing by zero", () => {
    const r = selectAssignee({
      policy: policy({ strategy: "weighted" }),
      members: [
        member("a", { hasOverride: true, weight: 0 }),
        member("b", { hasOverride: true, weight: 0 }),
      ],
      onlineUserIds: null,
    });
    expect(r.userId).toBeNull();
    expect(r.reason).toBe("no_candidates");
  });

  test("fixed always returns the pinned member", () => {
    const r = selectAssignee({
      policy: policy({ strategy: "fixed", fixedUserId: "b" }),
      members: [member("a", { openCount: 0 }), member("b", { openCount: 500 })],
      onlineUserIds: new Set(["a"]),
    });
    expect(r.userId).toBe("b");
    expect(r.reason).toBe("fixed");
  });

  test("fixed pointing at a departed member falls through to overflow", () => {
    const r = selectAssignee({
      policy: policy({ strategy: "fixed", fixedUserId: "gone" }),
      members: [member("a")],
      onlineUserIds: null,
    });
    expect(r.userId).toBeNull();
  });

  test("manual never assigns", () => {
    const r = selectAssignee({
      policy: policy({ strategy: "manual" }),
      members: [member("a")],
      onlineUserIds: new Set(["a"]),
    });
    expect(r.userId).toBeNull();
    expect(r.reason).toBe("manual_strategy");
  });
});

test.describe("selectAssignee — eligibility", () => {
  test("online_first prefers a CONNECTED agent over a merely status-available one", () => {
    // The original prod bug: someone marked "available" who had closed their
    // browser was picked over a truly-online teammate.
    const r = selectAssignee({
      policy: policy({ eligibility: "online_first" }),
      members: [member("a"), member("b")],
      onlineUserIds: new Set(["b"]),
    });
    expect(r.userId).toBe("b");
  });

  test("online_first falls back to available, then to anyone", () => {
    const busyOffline = [member("a", { availabilityStatus: "away" })];
    const r = selectAssignee({
      policy: policy({ eligibility: "online_first" }),
      members: busyOffline,
      onlineUserIds: new Set(),
    });
    expect(r.userId).toBe("a"); // last tier: any active member
  });

  test("online_only leaves it unassigned when nobody is connected", () => {
    const r = selectAssignee({
      policy: policy({ eligibility: "online_only" }),
      members: [member("a"), member("b")],
      onlineUserIds: new Set(),
    });
    expect(r.userId).toBeNull();
    expect(r.reason).toBe("no_candidates");
  });

  test("online_only FAILS OPEN when presence is unknown in this process", () => {
    // A worker with no socket visibility must not conclude the team is offline
    // and stop routing entirely.
    const r = selectAssignee({
      policy: policy({ eligibility: "online_only" }),
      members: [member("a")],
      onlineUserIds: null,
    });
    expect(r.userId).toBe("a");
  });

  test("available_only ignores sockets but honors the availability status", () => {
    const r = selectAssignee({
      policy: policy({ eligibility: "available_only" }),
      members: [member("a", { availabilityStatus: "away" }), member("b")],
      onlineUserIds: new Set(["a"]),
    });
    expect(r.userId).toBe("b");
  });

  test("any_active ignores presence and availability entirely", () => {
    const r = selectAssignee({
      policy: policy({ eligibility: "any_active" }),
      members: [member("a", { availabilityStatus: "offline" })],
      onlineUserIds: new Set(),
    });
    expect(r.userId).toBe("a");
  });

  test("a role filter keeps managers out of the rotation", () => {
    const r = selectAssignee({
      policy: policy({ eligibleRoles: ["agent"] }),
      members: [member("m", { role: "manager" }), member("a", { role: "agent" })],
      onlineUserIds: null,
    });
    expect(r.userId).toBe("a");
  });
});

test.describe("selectAssignee — membership", () => {
  test("includeAllMembers: an override row is an OPT-OUT", () => {
    const r = selectAssignee({
      policy: policy({ includeAllMembers: true }),
      members: [member("a", { hasOverride: true, enabled: false }), member("b")],
      onlineUserIds: null,
    });
    expect(r.userId).toBe("b");
  });

  test("explicit squad: only members WITH an enabled row take part", () => {
    const r = selectAssignee({
      policy: policy({ includeAllMembers: false }),
      members: [member("a"), member("b", { hasOverride: true, enabled: true })],
      onlineUserIds: null,
    });
    expect(r.userId).toBe("b");
  });

  test("an empty explicit squad assigns nobody", () => {
    const r = selectAssignee({
      policy: policy({ includeAllMembers: false }),
      members: [member("a"), member("b")],
      onlineUserIds: null,
    });
    expect(r.userId).toBeNull();
  });

  test("excludeUserIds keeps the offline agent out of their own rebalance", () => {
    const r = selectAssignee({
      policy: policy(),
      members: [member("a"), member("b")],
      onlineUserIds: null,
      excludeUserIds: ["a"],
    });
    expect(r.userId).toBe("b");
  });

  test("a team with no members assigns nobody instead of throwing", () => {
    const r = selectAssignee({ policy: policy(), members: [], onlineUserIds: null });
    expect(r.userId).toBeNull();
    expect(r.reason).toBe("no_candidates");
  });
});

test.describe("selectAssignee — capacity and overflow", () => {
  test("someone at their cap is skipped", () => {
    const r = selectAssignee({
      policy: policy({ defaultMaxOpen: 5 }),
      members: [member("a", { openCount: 5 }), member("b", { openCount: 4 })],
      onlineUserIds: null,
    });
    expect(r.userId).toBe("b");
  });

  test("a per-member cap overrides the policy default", () => {
    const r = selectAssignee({
      policy: policy({ defaultMaxOpen: 10 }),
      members: [
        member("a", { hasOverride: true, maxOpen: 2, openCount: 2 }),
        member("b", { openCount: 9 }),
      ],
      onlineUserIds: null,
    });
    expect(r.userId).toBe("b");
  });

  test("everyone full + leave_unassigned → triage queue", () => {
    const r = selectAssignee({
      policy: policy({ defaultMaxOpen: 1, overflow: "leave_unassigned" }),
      members: [member("a", { openCount: 1 }), member("b", { openCount: 1 })],
      onlineUserIds: null,
    });
    expect(r.userId).toBeNull();
    expect(r.reason).toBe("at_capacity");
  });

  test("everyone full + ignore_capacity → least loaded anyway", () => {
    const r = selectAssignee({
      policy: policy({ defaultMaxOpen: 1, overflow: "ignore_capacity" }),
      members: [member("a", { openCount: 9 }), member("b", { openCount: 3 })],
      onlineUserIds: null,
    });
    expect(r.userId).toBe("b");
    expect(r.reason).toBe("overflow_uncapped");
  });

  test("everyone full + fallback_user → the supervisor", () => {
    const r = selectAssignee({
      policy: policy({ defaultMaxOpen: 1, overflow: "fallback_user", fallbackUserId: "sup" }),
      members: [member("a", { openCount: 1 }), member("sup", { openCount: 1 })],
      onlineUserIds: null,
    });
    expect(r.userId).toBe("sup");
    expect(r.reason).toBe("fallback");
  });

  test("a STALE fallback id degrades to leave-unassigned, never a ghost assignee", () => {
    const r = selectAssignee({
      policy: policy({ defaultMaxOpen: 1, overflow: "fallback_user", fallbackUserId: "gone" }),
      members: [member("a", { openCount: 1 })],
      onlineUserIds: null,
    });
    expect(r.userId).toBeNull();
  });

  test("maxOpen 0 benches someone without deleting their configuration", () => {
    const r = selectAssignee({
      policy: policy(),
      members: [member("a", { hasOverride: true, maxOpen: 0 }), member("b")],
      onlineUserIds: null,
    });
    expect(r.userId).toBe("b");
  });

  test("a NEGATIVE cap clamps to 0 rather than reading as 'uncapped'", () => {
    const r = selectAssignee({
      policy: policy(),
      members: [member("a", { hasOverride: true, maxOpen: -1 })],
      onlineUserIds: null,
    });
    expect(r.userId).toBeNull();
  });

  test("the same inputs always produce the same answer", () => {
    const args = {
      policy: policy({ strategy: "weighted", cursorUserId: "a" }),
      members: [
        member("a", { hasOverride: true, weight: 3, served: 6 }),
        member("b", { hasOverride: true, weight: 2, served: 4 }),
        member("c", { hasOverride: true, weight: 1, served: 1 }),
      ],
      onlineUserIds: null,
    };
    const first = selectAssignee(args);
    for (let i = 0; i < 20; i++) expect(selectAssignee(args)).toEqual(first);
  });
});

test.describe("selectAssignee — continuity (previous agent)", () => {
  test("a returning customer goes back to the agent who knows them", () => {
    const r = selectAssignee({
      policy: policy({ preferPreviousAgent: true }),
      // Sara is less loaded, so plain least-busy would pick her.
      members: [member("ali", { openCount: 5 }), member("sara", { openCount: 0 })],
      onlineUserIds: null,
      previousUserId: "ali",
    });
    expect(r.userId).toBe("ali");
    expect(r.reason).toBe("previous_agent");
  });

  test("but NOT when that agent is offline — nobody waits for someone who left", () => {
    const r = selectAssignee({
      policy: policy({ preferPreviousAgent: true, eligibility: "online_only" }),
      members: [member("ali"), member("sara")],
      onlineUserIds: new Set(["sara"]),
      previousUserId: "ali",
    });
    expect(r.userId).toBe("sara");
  });

  test("and NOT when that agent is at their capacity limit", () => {
    const r = selectAssignee({
      policy: policy({ preferPreviousAgent: true, defaultMaxOpen: 3 }),
      members: [member("ali", { openCount: 3 }), member("sara", { openCount: 1 })],
      onlineUserIds: null,
      previousUserId: "ali",
    });
    expect(r.userId).toBe("sara");
  });

  test("and NOT when they've been excluded (a rebalance off that very agent)", () => {
    const r = selectAssignee({
      policy: policy({ preferPreviousAgent: true }),
      members: [member("ali"), member("sara")],
      onlineUserIds: null,
      previousUserId: "ali",
      excludeUserIds: ["ali"],
    });
    expect(r.userId).toBe("sara");
  });

  test("and NOT when they've left the policy's squad", () => {
    const r = selectAssignee({
      policy: policy({ preferPreviousAgent: true, includeAllMembers: false }),
      members: [
        member("ali"),
        member("sara", { hasOverride: true, enabled: true }),
      ],
      onlineUserIds: null,
      previousUserId: "ali",
    });
    expect(r.userId).toBe("sara");
  });

  test("the preference is off by default on a policy that disables it", () => {
    const r = selectAssignee({
      policy: policy({ preferPreviousAgent: false }),
      members: [member("ali", { openCount: 5 }), member("sara", { openCount: 0 })],
      onlineUserIds: null,
      previousUserId: "ali",
    });
    expect(r.userId).toBe("sara");
  });

  test("a previous agent who is no longer on the team is simply ignored", () => {
    const r = selectAssignee({
      policy: policy({ preferPreviousAgent: true }),
      members: [member("sara")],
      onlineUserIds: null,
      previousUserId: "ghost",
    });
    expect(r.userId).toBe("sara");
    expect(r.reason).toBe("picked");
  });
});

test.describe("routing rules", () => {
  const rule = (id: string, position: number, conditions: unknown, enabled = true) => ({
    id,
    name: id,
    policyId: `pol-${id}`,
    enabled,
    position,
    conditions,
  });

  test("first match wins, in position order", () => {
    const picked = pickRule(
      [rule("second", 1, { channels: ["whatsapp"] }), rule("first", 0, {})],
      { source: "inbound", channel: "whatsapp" },
    );
    expect(picked?.id).toBe("first"); // the catch-all sits higher
  });

  test("a disabled rule is skipped", () => {
    const picked = pickRule([rule("off", 0, {}, false), rule("on", 1, {})], {
      source: "inbound",
    });
    expect(picked?.id).toBe("on");
  });

  test("no match returns null so the caller falls back to the default policy", () => {
    expect(pickRule([rule("r", 0, { channels: ["instagram"] })], {
      source: "inbound",
      channel: "whatsapp",
    })).toBeNull();
  });

  test("clauses AND together; values within a clause OR", () => {
    const conditions = parseConditions({ channels: ["whatsapp", "messenger"], tagIds: ["vip"] });
    expect(
      matchesConditions(conditions, { source: "inbound", channel: "messenger", tagIds: ["vip"] }),
    ).toBe(true);
    // right channel, wrong tag → no match
    expect(
      matchesConditions(conditions, { source: "inbound", channel: "messenger", tagIds: ["other"] }),
    ).toBe(false);
  });

  test("a clause whose context is MISSING fails closed", () => {
    // A keyword rule must not fire on a campaign assignment, which carries no
    // message text — otherwise "refund" would capture every broadcast.
    expect(matchesConditions({ keywords: ["refund"] }, { source: "broadcast" })).toBe(false);
  });

  test("language matching is prefix-based so 'en' catches 'en-US'", () => {
    expect(matchesConditions({ languages: ["en"] }, { source: "inbound", language: "en-US" })).toBe(
      true,
    );
    expect(matchesConditions({ languages: ["en"] }, { source: "inbound", language: "fr" })).toBe(
      false,
    );
  });

  test("keyword matching is case-insensitive and substring-based", () => {
    expect(
      matchesConditions({ keywords: ["REFUND"] }, { source: "inbound", messageText: "I want a refund now" }),
    ).toBe(true);
  });

  test("an empty condition object is a catch-all", () => {
    expect(matchesConditions({}, { source: "rebalance" })).toBe(true);
  });

  test("corrupt conditions JSON degrades to a catch-all instead of throwing", () => {
    expect(parseConditions("not an object")).toEqual({});
    expect(parseConditions(null)).toEqual({});
    expect(parseConditions({ channels: [1, "whatsapp"] })).toEqual({ channels: ["whatsapp"] });
  });
});

test.describe("broadcast apportionment", () => {
  test("parts always sum to the total (the 33.3% rounding trap)", () => {
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(apportion(10, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(10);
  });

  test("a 50/20 share of 70 recipients is exactly 50 and 20", () => {
    expect(apportion(70, [50, 20])).toEqual([50, 20]);
  });

  test("degenerate inputs produce zeros, never NaN", () => {
    expect(apportion(0, [1, 2])).toEqual([0, 0]);
    expect(apportion(10, [0, 0])).toEqual([0, 0]);
    expect(apportion(10, [])).toEqual([]);
  });

  test("a large audience apportions exactly", () => {
    const parts = apportion(100_000, [3, 5, 7, 11]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100_000);
  });

  test("malformed split entries are dropped, not thrown on", () => {
    expect(
      parseSplit([
        { userId: "a", value: 5 },
        { userId: "", value: 3 },
        { userId: "b", value: 0 },
        "nope",
        { userId: "c", value: 2.7 },
      ]),
    ).toEqual([
      { userId: "a", value: 5 },
      { userId: "c", value: 2 },
    ]);
  });
});
