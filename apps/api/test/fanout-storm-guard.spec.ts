import { describe, expect, it } from "vitest";

import { FANOUT_RULES } from "@/realtime/fanout-rules";
import type { RealtimeEmitter } from "@/realtime/emitter.service";

/**
 * B-M5 — the frame-ceiling guard, asserted where the decision actually lives.
 *
 * The plan called for a "socket frame-count regression spec (200-inbound burst,
 * per-room frame ceiling)". Counting frames over a real socket would measure the
 * same thing far more slowly and far less precisely, because the property that
 * matters is not a number — it is WHICH ROOM each event fans to, and that is a
 * pure decision table (`FANOUT_RULES`). Driving the table directly makes the
 * assertion deterministic, instant, and CI-safe.
 *
 * THE INVARIANT (fanout-rules.ts's own docblock): "A bug where someone misses a
 * frame they wanted is recoverable. A bug where 10k frames fan out per second to
 * every tab is not."
 *
 * Concretely, for broadcasts that splits into two classes:
 *
 *   PER-CAMPAIGN  (`broadcast.status_changed`, `broadcast.progress`)
 *                 fire O(1) times per campaign → team-wide is correct, every
 *                 agent watches the campaign card.
 *   PER-RECIPIENT (`broadcast.recipient_message_sent`,
 *                 `broadcast.conversation_reopened`)
 *                 fire ONCE PER RECIPIENT → a 10k-recipient send would put 10k
 *                 frames on every open tab in the workspace. These MUST stay
 *                 conversation-scoped.
 *
 * So a 10k broadcast costs ~2 team-room frames, not 20,000. This spec fails the
 * moment someone "fixes" a missing frame by widening one of the per-recipient
 * rules to `emitToWorkspace`, which is the single change that would turn a
 * routine campaign into a workspace-wide realtime storm.
 */

type Call = { method: string; room: string; event: string };

/** Recording stand-in — every emitter method just logs what it was asked to do. */
function recordingEmitter(): { calls: Call[]; emitter: RealtimeEmitter } {
  const calls: Call[] = [];
  const rec =
    (method: string) =>
    (roomKey: string, event: string, ..._rest: unknown[]): void => {
      calls.push({ method, room: roomKey, event });
    };
  const emitter = {
    emitToWorkspace: rec("emitToWorkspace"),
    emitToConversation: rec("emitToConversation"),
    emitToUser: rec("emitToUser"),
    emitToChannel: rec("emitToChannel"),
    // These two take (workspaceId, conversationId, event, payload) — record the
    // conversation id as the room, since that is the scope under test.
    emitAboutConversation: (
      _workspaceId: string,
      conversationId: string,
      event: string,
    ): void => {
      calls.push({ method: "emitAboutConversation", room: conversationId, event });
    },
    emitAboutConversationAlso: (
      _workspaceId: string,
      conversationId: string,
      event: string,
    ): void => {
      calls.push({ method: "emitAboutConversationAlso", room: conversationId, event });
    },
  } as unknown as RealtimeEmitter;
  return { calls, emitter };
}

/** Minimal synthetic event — the rules only read fields, never the DB. */
function broadcastEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: "ws_1",
    broadcastId: "bc_1",
    conversationId: "conv_1",
    contactId: "contact_1",
    messageId: "msg_1",
    status: "running",
    sent: 1,
    delivered: 1,
    failed: 0,
    total: 10_000,
    message: { id: "msg_1", body: "hi", direction: "out", status: "sent" },
    preview: "hi",
    lastMessageAt: new Date().toISOString(),
    unreadCount: 0,
    at: new Date().toISOString(),
  };
}

function runRule(type: string, event: Record<string, unknown>): Call[] {
  const rule = (FANOUT_RULES as Record<string, unknown>)[type];
  expect(rule, `${type} must have a fanout rule (null is an explicit decision)`).toBeDefined();
  if (rule === null) return [];
  const { calls, emitter } = recordingEmitter();
  (rule as (e: unknown, em: RealtimeEmitter) => void)(event, emitter);
  return calls;
}

describe("broadcast fanout — the 10k-recipient storm guard", () => {
  // Fires once per RECIPIENT. Team-wide here is the storm.
  const PER_RECIPIENT = ["broadcast.recipient_message_sent", "broadcast.conversation_reopened"];
  // Fires once per CAMPAIGN. Team-wide here is correct and intended.
  const PER_CAMPAIGN = ["broadcast.status_changed", "broadcast.progress"];

  for (const type of PER_RECIPIENT) {
    it(`${type} never reaches the workspace room`, () => {
      const calls = runRule(type, broadcastEvent());
      expect(calls.length, `${type} should emit something`).toBeGreaterThan(0);
      const teamWide = calls.filter((c) => c.method === "emitToWorkspace");
      expect(
        teamWide,
        `${type} fires ONCE PER RECIPIENT — a workspace-scoped emit puts one frame ` +
          `per recipient on every open tab (10k recipients = 10k frames each). ` +
          `Keep it conversation-scoped.`,
      ).toEqual([]);
      // And it must genuinely be conversation-scoped, not silently dropped.
      expect(
        calls.every(
          (c) => c.method === "emitToConversation" || c.method.startsWith("emitAboutConversation"),
        ),
        `${type} must fan to the conversation room only, got ${JSON.stringify(calls)}`,
      ).toBe(true);
    });
  }

  for (const type of PER_CAMPAIGN) {
    it(`${type} stays team-wide (one frame per campaign, not per recipient)`, () => {
      const calls = runRule(type, broadcastEvent());
      expect(
        calls.some((c) => c.method === "emitToWorkspace"),
        `${type} is a per-CAMPAIGN signal every agent watches — narrowing it to the ` +
          `conversation room would hide campaign progress from the team.`,
      ).toBe(true);
    });
  }

  it("a 10k-recipient send costs O(1) workspace frames, not O(recipients)", () => {
    const RECIPIENTS = 10_000;
    let workspaceFrames = 0;
    // Per-campaign frames: status at start + end, progress ticks. Model a
    // generous 50 progress ticks — the runner batches them, it does not emit
    // one per recipient.
    for (const type of ["broadcast.status_changed", ...Array(50).fill("broadcast.progress")]) {
      workspaceFrames += runRule(type, broadcastEvent()).filter(
        (c) => c.method === "emitToWorkspace",
      ).length;
    }
    // Per-recipient frames: the actual send fanout, once per recipient.
    for (let i = 0; i < 200; i++) {
      workspaceFrames += runRule("broadcast.recipient_message_sent", broadcastEvent()).filter(
        (c) => c.method === "emitToWorkspace",
      ).length;
    }
    // 200 sampled recipients contributed ZERO workspace frames, so the full
    // 10k contributes zero too — the total is bounded by campaign-level events.
    expect(
      workspaceFrames,
      `workspace-room frames must be bounded by CAMPAIGN events, not by the ` +
        `${RECIPIENTS} recipients`,
    ).toBeLessThanOrEqual(51);
  });
});
