/**
 * Unit tests for the inbox thread reducers — the single source of truth three
 * consumers share (live hook, LRU cache shell, contact panel). These pin the
 * behaviors that realtime correctness leans on and that Playwright only
 * exercises indirectly:
 *
 *   - IDENTITY on no-change: a reducer that allocates on a no-op re-renders
 *     the whole thread per redundant frame (the re-render audit's bug class).
 *   - MONOTONIC message status: Meta redelivers status webhooks unordered, so
 *     a stale `delivered` after `read` must never regress the bubble.
 *   - Coverage bookkeeping: every subscribed event is either reduced or
 *     explicitly excluded — the dev-time invariant that catches "wired the
 *     live hook, forgot the cache shell".
 *
 *   pnpm --filter @ccp/web exec vitest run
 */
import { describe, expect, it } from "vitest";

import {
  applyCallArtifacts,
  applyContactUpdate,
  applyConversationAssignment,
  applyConversationRead,
  applyConversationStatus,
  applyMessageReaction,
  applyMessageStatus,
  assertReducerCoverage,
  REDUCER_EXCLUSIONS,
  THREAD_REDUCER_EVENTS,
} from "@/features/inbox/lib/thread-reducers";
import type {
  CallSnapshot,
  ConversationWithRefs,
  Message,
  User,
} from "@ccp/shared/types";

// Minimal thread fixture — reducers only touch the fields they patch, so the
// cast keeps the fixture honest without replicating the full hydration shape.
function makeThread(overrides?: {
  messages?: Partial<Message>[];
  status?: string;
  unreadCount?: number;
  assignedUserId?: string | null;
}): ConversationWithRefs {
  return {
    conversation: {
      id: "conv1",
      status: overrides?.status ?? "open",
      unreadCount: overrides?.unreadCount ?? 0,
      assignedUserId: overrides?.assignedUserId ?? null,
      openFlagCount: 0,
    },
    contact: { id: "contact1", name: "Test" },
    assignedUser: null,
    messages: (overrides?.messages ?? []) as Message[],
    notes: [],
    lastInboundAt: null,
  } as unknown as ConversationWithRefs;
}

function msg(id: string, status: string): Partial<Message> {
  return { id, status } as Partial<Message>;
}

describe("identity on no-change (re-render economy)", () => {
  it("applyConversationStatus returns the SAME reference for an unchanged status", () => {
    const prev = makeThread({ status: "open" });
    expect(applyConversationStatus(prev, { status: "open" as never })).toBe(prev);
  });

  it("applyConversationRead is identity when unread is already 0", () => {
    const prev = makeThread({ unreadCount: 0 });
    expect(
      applyConversationRead(prev, {
        conversationId: "conv1",
        readByUserId: "u1",
        workspaceId: "w1",
      }),
    ).toBe(prev);
  });

  it("applyConversationRead zeroes a non-zero counter (team-wide read model)", () => {
    const prev = makeThread({ unreadCount: 4 });
    const next = applyConversationRead(prev, {
      conversationId: "conv1",
      readByUserId: "u1",
      workspaceId: "w1",
    });
    expect(next).not.toBe(prev);
    expect(next.conversation.unreadCount).toBe(0);
  });

  it("applyConversationAssignment is identity when the assignee id is unchanged", () => {
    const prev = makeThread({ assignedUserId: null });
    expect(applyConversationAssignment(prev, { assignedUser: null })).toBe(prev);
  });

  it("applyConversationAssignment patches both the id and the embedded user", () => {
    const user = { id: "u9", name: "Agent" } as unknown as User;
    const next = applyConversationAssignment(makeThread(), { assignedUser: user });
    expect(next.conversation.assignedUserId).toBe("u9");
    expect(next.assignedUser).toBe(user);
  });

  it("applyContactUpdate bails by identity on a different contact id", () => {
    const prev = makeThread();
    const next = applyContactUpdate(prev, {
      contact: { id: "someone-else" } as never,
    });
    expect(next).toBe(prev);
  });
});

describe("applyMessageStatus — monotonic rank guard (RT-4)", () => {
  it("advances pending → sent → delivered → read", () => {
    let thread = makeThread({ messages: [msg("m1", "pending")] });
    for (const status of ["sent", "delivered", "read"] as const) {
      thread = applyMessageStatus(thread, { messageId: "m1", status });
      expect(thread.messages[0]!.status).toBe(status);
    }
  });

  it("a STALE delivered frame after read is a no-op by identity — Meta redelivers unordered", () => {
    const prev = makeThread({ messages: [msg("m1", "read")] });
    expect(
      applyMessageStatus(prev, { messageId: "m1", status: "delivered" as never }),
    ).toBe(prev);
  });

  it("failed is terminal: wins over delivered, then can't be overwritten", () => {
    let thread = makeThread({ messages: [msg("m1", "delivered")] });
    thread = applyMessageStatus(thread, {
      messageId: "m1",
      status: "failed" as never,
      errorCode: 131047,
      errorTitle: "Re-engagement message",
    });
    expect(thread.messages[0]!.status).toBe("failed");
    expect((thread.messages[0] as { statusErrorCode?: number }).statusErrorCode).toBe(131047);
    // A late `read` for the same message must not resurrect it.
    expect(
      applyMessageStatus(thread, { messageId: "m1", status: "read" as never }),
    ).toBe(thread);
  });

  it("unknown message id bails by identity before any allocation", () => {
    const prev = makeThread({ messages: [msg("m1", "sent")] });
    expect(
      applyMessageStatus(prev, { messageId: "nope", status: "read" as never }),
    ).toBe(prev);
  });

  it("equal-rank redelivery is a no-op", () => {
    const prev = makeThread({ messages: [msg("m1", "delivered")] });
    expect(
      applyMessageStatus(prev, { messageId: "m1", status: "delivered" as never }),
    ).toBe(prev);
  });
});

describe("applyMessageReaction — two-sided reactions", () => {
  it("customer and agent reactions coexist on independent fields", () => {
    let thread = makeThread({ messages: [msg("m1", "delivered")] });
    thread = applyMessageReaction(thread, { messageId: "m1", emoji: "👍" });
    thread = applyMessageReaction(thread, { messageId: "m1", emoji: "❤️", actor: "agent" });
    const m = thread.messages[0] as { reaction?: string; agentReaction?: string };
    expect(m.reaction).toBe("👍");
    expect(m.agentReaction).toBe("❤️");
  });

  it("removal (emoji null) DROPS the field for that side only", () => {
    let thread = makeThread({ messages: [msg("m1", "delivered")] });
    thread = applyMessageReaction(thread, { messageId: "m1", emoji: "👍" });
    thread = applyMessageReaction(thread, { messageId: "m1", emoji: "❤️", actor: "agent" });
    thread = applyMessageReaction(thread, { messageId: "m1", emoji: null });
    const m = thread.messages[0] as { reaction?: string; agentReaction?: string };
    expect("reaction" in m).toBe(false);
    expect(m.agentReaction).toBe("❤️");
  });

  it("same-emoji redelivery is a no-op by identity", () => {
    let thread = makeThread({ messages: [msg("m1", "delivered")] });
    thread = applyMessageReaction(thread, { messageId: "m1", emoji: "👍" });
    expect(applyMessageReaction(thread, { messageId: "m1", emoji: "👍" })).toBe(thread);
  });
});

describe("applyCallArtifacts — post-call recording / transcript arrival", () => {
  function threadWithCall(call?: Partial<CallSnapshot>): ConversationWithRefs {
    const base = makeThread();
    return {
      ...base,
      calls: [
        {
          id: "call1",
          conversationId: "conv1",
          status: "completed",
          direction: "out",
          ...call,
        } as CallSnapshot,
      ],
    };
  }

  const frame = (over?: Partial<Parameters<typeof applyCallArtifacts>[1]>) => ({
    callId: "call1",
    hasRecording: true,
    hasTranscript: false,
    transcriptLanguage: null,
    transcriptPending: true,
    ...over,
  });

  it("patches the matching call and leaves a new array (recording landed)", () => {
    const prev = threadWithCall();
    const next = applyCallArtifacts(prev, frame());
    expect(next).not.toBe(prev);
    expect(next.calls?.[0]?.hasRecording).toBe(true);
    expect(next.calls?.[0]?.transcriptPending).toBe(true);
    // Untouched fields survive the merge — the frame is a patch, not a replace.
    expect(next.calls?.[0]?.status).toBe("completed");
  });

  it("clears transcriptPending when the transcript itself lands", () => {
    const prev = threadWithCall({ hasRecording: true, transcriptPending: true });
    const next = applyCallArtifacts(
      prev,
      frame({ hasTranscript: true, transcriptLanguage: "ar", transcriptPending: false }),
    );
    expect(next.calls?.[0]?.hasTranscript).toBe(true);
    expect(next.calls?.[0]?.transcriptLanguage).toBe("ar");
    expect(next.calls?.[0]?.transcriptPending).toBe(false);
  });

  it("is identity for a redelivered frame that changes nothing", () => {
    const prev = threadWithCall({
      hasRecording: true,
      hasTranscript: false,
      transcriptLanguage: null,
      transcriptPending: true,
    });
    expect(applyCallArtifacts(prev, frame())).toBe(prev);
  });

  it("is identity for a call the snapshot has never seen", () => {
    const prev = threadWithCall();
    expect(applyCallArtifacts(prev, frame({ callId: "some-other-call" }))).toBe(prev);
  });
});

describe("reducer coverage bookkeeping", () => {
  it("every REDUCER_EXCLUSIONS entry carries a non-empty reason", () => {
    for (const [event, reason] of REDUCER_EXCLUSIONS) {
      expect(reason.length, `${event} needs a documented reason`).toBeGreaterThan(0);
    }
  });

  it("call:permission is explicitly excluded (activity-refresh signal, no thread patch)", () => {
    expect(REDUCER_EXCLUSIONS.has("call:permission")).toBe(true);
  });

  it("assertReducerCoverage passes for every covered + excluded event", () => {
    const all = [
      ...THREAD_REDUCER_EVENTS.map((e) => e.event as string),
      ...REDUCER_EXCLUSIONS.keys(),
    ];
    expect(() => assertReducerCoverage(all)).not.toThrow();
  });

  it("assertReducerCoverage throws on an event nobody accounted for", () => {
    // Dev-only invariant: guard the guard. (Production no-ops it, so pin the
    // env this spec assumes rather than silently passing if NODE_ENV changes.)
    expect(process.env.NODE_ENV).not.toBe("production");
    expect(() => assertReducerCoverage(["totally:unwired"])).toThrow();
  });
});
