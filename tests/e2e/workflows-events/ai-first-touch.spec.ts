import { test, expect } from "@playwright/test";

import { toWirePayload } from "@ccp/shared/outbound-webhooks/public-events";

/**
 * First-touch greeting coordination (welcome workflow + AI).
 *
 * `toWirePayload` decides the `ai_enabled` value that rides each outbound
 * `message.received` webhook — the n8n flow gates its auto-reply on it. When
 * the org sets `firstTouchGreeter = "workflow"`, the AI must stay silent on the
 * FIRST inbound of a brand-new conversation (a welcome workflow greets), but
 * answer every message after. This is the pure decision that enforces it, so we
 * test it directly (no stack).
 */

// Minimal message.received envelope `data` — the wire helpers tolerate the
// absent contact/message blocks (they emit null), so we only set what the
// ai_enabled / session_kind decision reads.
function data(opts: { aiEnabled: boolean; isNew: boolean; sessionKind?: string }) {
  return {
    contact: null,
    message: null,
    conversation: { id: "c1", status: "pending", unread_count: 1, aiEnabled: opts.aiEnabled },
    is_new_conversation: opts.isNew,
    reopened: false,
    session_kind: opts.sessionKind ?? "first_ever",
  };
}

test.describe("First-touch greeting (welcome workflow vs AI)", () => {
  test("firstTouchGreeter=workflow + NEW conversation → AI suppressed on first inbound", () => {
    const out = toWirePayload("message.received", data({ aiEnabled: true, isNew: true }), {
      channelBase: null,
      teamAiAutopilotEnabled: true,
      firstTouchGreeter: "workflow",
    });
    expect(out.ai_enabled).toBe(false);
    expect(out.ai_suppressed_reason).toBe("first_touch_workflow");
  });

  test("firstTouchGreeter=workflow + EXISTING conversation → AI runs (2nd+ message)", () => {
    const out = toWirePayload("message.received", data({ aiEnabled: true, isNew: false, sessionKind: "continued" }), {
      channelBase: null,
      teamAiAutopilotEnabled: true,
      firstTouchGreeter: "workflow",
    });
    expect(out.ai_enabled).toBe(true);
    expect(out.ai_suppressed_reason).toBeUndefined();
  });

  test("firstTouchGreeter=ai (default) + NEW conversation → AI runs (no suppression)", () => {
    const out = toWirePayload("message.received", data({ aiEnabled: true, isNew: true }), {
      channelBase: null,
      teamAiAutopilotEnabled: true,
      firstTouchGreeter: "ai",
    });
    expect(out.ai_enabled).toBe(true);
    expect(out.ai_suppressed_reason).toBeUndefined();
  });

  test("suppression never overrides an already-paused thread staying false", () => {
    // aiEnabled already false (a human took over) → stays false regardless.
    const out = toWirePayload("message.received", data({ aiEnabled: false, isNew: false, sessionKind: "continued" }), {
      channelBase: null,
      teamAiAutopilotEnabled: true,
      firstTouchGreeter: "ai",
    });
    expect(out.ai_enabled).toBe(false);
  });

  test("session_kind passes through to the wire payload", () => {
    for (const kind of ["first_ever", "returning_session", "continued"]) {
      const out = toWirePayload("message.received", data({ aiEnabled: true, isNew: false, sessionKind: kind }), {
        channelBase: null,
        teamAiAutopilotEnabled: true,
        firstTouchGreeter: "ai",
      });
      expect(out.session_kind).toBe(kind);
    }
  });
});
