import { test, expect } from "@playwright/test";

import {
  conversationRelationWhere,
  isRestrictedViewer,
  visibilityScopeKey,
  visibilityWhere,
  type ConversationViewer,
} from "../../../apps/api/src/lib/conversations/visibility";

/**
 * Agent conversation-visibility boundary.
 *
 * These pin the RULES. Every conversation read in the product composes one of
 * these three functions into its `where`, and the realtime layer decides room
 * membership from `isRestrictedViewer`, so a mistake here is a mistake
 * everywhere — which is exactly why the rules live in one pure module instead
 * of being re-expressed at each call site.
 *
 * The most important test in this file is the HANDOVER one: scoping keys on
 * the CURRENT assignee, never on message authorship, which is what lets an
 * admin move a thread and have the new owner see all of its history.
 */

const viewer = (over: Partial<ConversationViewer> = {}): ConversationViewer => ({
  userId: "u_agent",
  teamId: "t1",
  role: "agent",
  agentConversationVisibility: "assigned",
  ...over,
});

test.describe("who is restricted", () => {
  test("an agent IS restricted when the org asked for it", () => {
    expect(isRestrictedViewer(viewer())).toBe(true);
  });

  test("an agent is NOT restricted on a default org", () => {
    expect(isRestrictedViewer(viewer({ agentConversationVisibility: "team" }))).toBe(
      false,
    );
  });

  test("admin, manager and superAdmin are NEVER restricted", () => {
    for (const role of ["admin", "manager", "superAdmin"] as const) {
      expect(isRestrictedViewer(viewer({ role }))).toBe(false);
    }
  });

  test("a missing/unknown setting falls back to unrestricted", () => {
    // Matches the column default. Failing OPEN here is deliberate: a bad read
    // must not lock an entire org out of its own inbox. Per-conversation checks
    // fail CLOSED instead — see the guard.
    expect(isRestrictedViewer(viewer({ agentConversationVisibility: null }))).toBe(false);
    expect(isRestrictedViewer(viewer({ agentConversationVisibility: undefined }))).toBe(
      false,
    );
    expect(isRestrictedViewer(viewer({ agentConversationVisibility: "nonsense" }))).toBe(
      false,
    );
  });
});

test.describe("the where fragments", () => {
  test("restricted → narrowed to the viewer's own conversations", () => {
    expect(visibilityWhere(viewer())).toEqual({ assignedUserId: "u_agent" });
    expect(conversationRelationWhere(viewer())).toEqual({
      conversation: { assignedUserId: "u_agent" },
    });
  });

  test("unrestricted → an EMPTY fragment, so the query is unchanged", () => {
    // This is what makes the feature zero-risk for orgs that never turn it on:
    // spreading `{}` produces byte-identical SQL to before it existed.
    const admin = viewer({ role: "admin" });
    expect(visibilityWhere(admin)).toEqual({});
    expect(conversationRelationWhere(admin)).toEqual({});
  });

  test("the fragment names the CURRENT assignee — never the message author", () => {
    // The handover rule in one assertion. Because the filter is on
    // `assignedUserId`, reassigning a thread from Ali to Sara instantly gives
    // Sara the whole thread — every message, note and event, including Ali's —
    // and removes it from Ali. A filter on authorship would have handed Sara a
    // thread full of holes.
    const sara = visibilityWhere(viewer({ userId: "u_sara" }));
    expect(sara).toEqual({ assignedUserId: "u_sara" });
    expect(JSON.stringify(sara)).not.toContain("author");
    expect(JSON.stringify(sara)).not.toContain("senderUserId");
  });
});

test.describe("cache scoping", () => {
  test("each restricted agent gets their OWN memo key", () => {
    // Without this the per-team counts memo would serve one agent another
    // agent's totals — a leak no WHERE clause could catch, because the query
    // never runs on a cache hit.
    expect(visibilityScopeKey(viewer({ userId: "a" }))).toBe("u:a");
    expect(visibilityScopeKey(viewer({ userId: "b" }))).toBe("u:b");
    expect(visibilityScopeKey(viewer({ userId: "a" }))).not.toBe(
      visibilityScopeKey(viewer({ userId: "b" })),
    );
  });

  test("every unrestricted viewer shares one key, so the cache stays effective", () => {
    expect(visibilityScopeKey(viewer({ role: "admin", userId: "x" }))).toBe("team");
    expect(visibilityScopeKey(viewer({ role: "manager", userId: "y" }))).toBe("team");
    expect(visibilityScopeKey(viewer({ agentConversationVisibility: "team" }))).toBe(
      "team",
    );
  });
});
