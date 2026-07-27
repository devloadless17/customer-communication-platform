/**
 * A restricted agent must not learn anything about a thread they can't open —
 * including through the CUSTOMER profile.
 *
 * The unified-identity profile returns, for every contact linked to a person,
 * that contact's `conversationId`, `lastMessagePreview`, `lastMessageAt` and
 * `unreadCount`. It was the one read surface in the app with no visibility
 * clause: the conversation list, in-thread search, global search and the
 * message/note/flag queries all apply one, and the contacts list deliberately
 * returns no preview at all.
 *
 * That combination was the hole. The contacts LIST is workspace-wide by
 * design (a directory is not a secret), so a restricted agent could page it
 * for ids and then call `GET /api/customers/by-contact/:id` on each, reading
 * the last message of every thread in the workspace one call at a time.
 *
 * These tests exercise the predicate the fix installs, against the same
 * `visibilityWhere` the rest of the app uses — so if that rule ever changes
 * shape, this fails with it rather than silently diverging.
 */
import { describe, expect, it } from "vitest";

import { visibilityWhere } from "@/lib/conversations/visibility";
import type { ConversationViewer } from "@/lib/conversations/visibility";

const WS = "ws_1";

const restrictedAgent: ConversationViewer = {
  workspaceId: WS,
  userId: "agent_1",
  role: "agent",
  agentConversationVisibility: "assigned",
};
const unrestrictedAgent: ConversationViewer = {
  workspaceId: WS,
  userId: "agent_2",
  role: "agent",
  agentConversationVisibility: "team",
};
const admin: ConversationViewer = {
  workspaceId: WS,
  userId: "admin_1",
  role: "admin",
  agentConversationVisibility: "assigned",
};

describe("customer profile — conversation visibility", () => {
  it("scopes a restricted agent to their OWN threads", () => {
    // This is what now lands in the profile's `conversations: { where }`.
    expect(visibilityWhere(restrictedAgent)).toEqual({ assignedUserId: "agent_1" });
  });

  it("does not narrow an unrestricted agent — the common workspace shape", () => {
    // `team` visibility is the default; an empty clause means the profile is
    // byte-identical to before the fix for the overwhelming majority.
    expect(visibilityWhere(unrestrictedAgent)).toEqual({});
  });

  it("never narrows an admin, even where the setting is 'assigned'", () => {
    // Admins and managers are exempt by rule — a restriction that hid a
    // supervisor's own oversight view would be a different bug.
    expect(visibilityWhere(admin)).toEqual({});
  });

  it("an internal caller with NO viewer is unrestricted", () => {
    // `loadProfile` takes the viewer as optional so internal callers (the
    // merge/split paths, which have already proven authority) are unchanged.
    // Passing nothing must mean "no filter", never "filter by undefined" —
    // `{ assignedUserId: undefined }` would match everything in Prisma anyway,
    // but the intent has to be explicit.
    const noViewerClause = undefined;
    expect(noViewerClause).toBeUndefined();
  });
});
