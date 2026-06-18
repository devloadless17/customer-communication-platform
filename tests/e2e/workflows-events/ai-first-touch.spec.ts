import { test, expect } from "@playwright/test";

import { sessionKindFromFlags } from "@ccp/shared/events/types";
import { toWirePayload } from "@ccp/shared/outbound-webhooks/public-events";

/**
 * Session model + first-touch greeting coordination (welcome workflow + AI).
 *
 * A "session" is bounded by conversation CLOSE: the first inbound is
 * `first_ever`, the first inbound after a close (the reopen) is
 * `returning_session`, everything else in an open session is `continued`.
 *
 * When the org sets `firstTouchGreeter = "workflow"`, the AI must stay silent
 * on the first inbound of a session (first_ever OR returning_session) so a
 * welcome workflow greets alone — and answer on `continued` messages. Both the
 * rule (`sessionKindFromFlags`) and the suppression decision (`toWirePayload`)
 * are pure, so we test them directly (no stack).
 */

test.describe("session_kind rule (bounded by conversation close)", () => {
  test("new conversation → first_ever", () => {
    expect(sessionKindFromFlags(true, false)).toBe("first_ever");
  });
  test("inbound that reopened a closed thread → returning_session", () => {
    expect(sessionKindFromFlags(false, true)).toBe("returning_session");
  });
  test("message inside an open session → continued", () => {
    expect(sessionKindFromFlags(false, false)).toBe("continued");
  });
  test("new conversation wins over reopen flag → first_ever", () => {
    // A brand-new conversation can't also be a reopen, but guard the ordering.
    expect(sessionKindFromFlags(true, true)).toBe("first_ever");
  });
});

// Minimal message.received envelope `data` — the wire helpers tolerate absent
// contact/message blocks (they emit null), so we set only what the
// ai_enabled / session_kind decision reads.
function data(opts: { aiEnabled: boolean; sessionKind: string }) {
  return {
    contact: null,
    message: null,
    conversation: { id: "c1", status: "pending", unread_count: 1, aiEnabled: opts.aiEnabled },
    is_new_conversation: opts.sessionKind === "first_ever",
    reopened: opts.sessionKind === "returning_session",
    session_kind: opts.sessionKind,
  };
}

function wire(sessionKind: string, firstTouchGreeter: "ai" | "workflow", aiEnabled = true) {
  return toWirePayload("message.received", data({ aiEnabled, sessionKind }), {
    channelBase: null,
    teamAiAutopilotEnabled: true,
    firstTouchGreeter,
  });
}

test.describe("First-touch greeting (welcome workflow vs AI)", () => {
  test("workflow greeter + first_ever → AI suppressed", () => {
    const out = wire("first_ever", "workflow");
    expect(out.ai_enabled).toBe(false);
    expect(out.ai_suppressed_reason).toBe("first_touch_workflow");
  });

  test("workflow greeter + returning_session (after close) → AI suppressed", () => {
    const out = wire("returning_session", "workflow");
    expect(out.ai_enabled).toBe(false);
    expect(out.ai_suppressed_reason).toBe("first_touch_workflow");
  });

  test("workflow greeter + continued → AI runs (rest of the session)", () => {
    const out = wire("continued", "workflow");
    expect(out.ai_enabled).toBe(true);
    expect(out.ai_suppressed_reason).toBeUndefined();
  });

  test("ai greeter (default) + first_ever → AI runs (no suppression)", () => {
    const out = wire("first_ever", "ai");
    expect(out.ai_enabled).toBe(true);
    expect(out.ai_suppressed_reason).toBeUndefined();
  });

  test("already-paused thread stays paused regardless of greeter", () => {
    const out = wire("continued", "ai", /* aiEnabled */ false);
    expect(out.ai_enabled).toBe(false);
  });

  test("session_kind passes through to the wire payload", () => {
    for (const kind of ["first_ever", "returning_session", "continued"]) {
      expect(wire(kind, "ai").session_kind).toBe(kind);
    }
  });
});
