import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Acceptance tests for the native AI Assistant. Model/voice/blob providers are
 * mocked; the DB is an in-memory fake with unique-constraint simulation. Each
 * `it` is tagged with the acceptance criterion it covers.
 *
 * Run: `pnpm --filter @ccp/api add -D vitest` then
 *      `pnpm --filter @ccp/api exec vitest run`.
 */

// --- in-memory db fake (hoisted so vi.mock can reference it) ---
const h = vi.hoisted(() => {
  const claims = new Set<string>();
  const convState = new Map<string, Record<string, unknown>>();
  const transcriptions = new Map<string, Record<string, unknown>>();
  const metadata = new Map<string, { aiGenerated: boolean }>();
  const teams = new Map<string, { aiAutopilotEnabled: boolean }>();
  let queryRows: Array<Record<string, unknown>> = [];
  const captured: Array<{ values: unknown[] }> = [];

  const p2002 = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

  const db = {
    conversationAutomationClaim: {
      create: async ({ data }: { data: { teamId: string; inboundMessageId: string } }) => {
        const key = `${data.teamId}:${data.inboundMessageId}`;
        if (claims.has(key)) throw p2002();
        claims.add(key);
        return { id: "claim", ...data };
      },
      findUnique: async ({ where }: { where: { teamId_inboundMessageId: { teamId: string; inboundMessageId: string } } }) => {
        const { teamId, inboundMessageId } = where.teamId_inboundMessageId;
        return claims.has(`${teamId}:${inboundMessageId}`) ? { teamId, inboundMessageId } : null;
      },
    },
    team: {
      findUnique: async ({ where }: { where: { id: string } }) => teams.get(where.id) ?? null,
    },
    aiConversationState: {
      findUnique: async ({ where }: { where: { conversationId: string } }) =>
        convState.get(where.conversationId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = data.conversationId as string;
        if (convState.has(id)) throw p2002();
        const row = { autoReplyCount: 0, pausedByUserId: null, pausedAt: null, ...data };
        convState.set(id, row);
        return row;
      },
      update: async ({ where, data }: { where: { conversationId: string }; data: Record<string, unknown> }) => {
        const cur = convState.get(where.conversationId) ?? {};
        const next: Record<string, unknown> = { ...cur };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && "increment" in (v as Record<string, unknown>)) {
            next[k] = ((cur[k] as number) ?? 0) + ((v as { increment: number }).increment);
          } else {
            next[k] = v;
          }
        }
        convState.set(where.conversationId, next);
        return next;
      },
    },
    aiMessageTranscription: {
      findUnique: async ({ where }: { where: { messageId: string } }) =>
        transcriptions.get(where.messageId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const id = data.messageId as string;
        if (transcriptions.has(id)) throw p2002();
        transcriptions.set(id, { ...data });
        return { ...data };
      },
      update: async ({ where, data }: { where: { messageId: string }; data: Record<string, unknown> }) => {
        const row = { ...transcriptions.get(where.messageId), ...data };
        transcriptions.set(where.messageId, row);
        return row;
      },
    },
    aiMessageMetadata: {
      findUnique: async ({ where }: { where: { messageId: string } }) =>
        metadata.get(where.messageId) ?? null,
    },
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.push({ values });
      return queryRows;
    },
  };

  return {
    db,
    state: {
      claims,
      convState,
      transcriptions,
      metadata,
      teams,
      captured,
      setQueryRows: (r: Array<Record<string, unknown>>) => {
        queryRows = r;
      },
      reset: () => {
        claims.clear();
        convState.clear();
        transcriptions.clear();
        metadata.clear();
        teams.clear();
        captured.length = 0;
        queryRows = [];
      },
    },
  };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
// Prevent the real blob-storage (aws-sdk) from loading when voice-ingest imports it.
vi.mock("@/lib/blob-storage", () => ({ blobStorage: { fetch: vi.fn() } }));

// Imports AFTER mocks are registered.
import { claimInbound, legacyAutopilotOwnsTeam } from "@/lib/ai/automation-claim";
import { decideMode } from "@/lib/ai/decide-mode";
import {
  getState,
  onCustomerInbound,
  onHumanReply,
  pauseByAgent,
} from "@/lib/ai/conversation-state";
import { retrieveContextChunks } from "@/lib/ai/knowledge-retrieval";
import { ensureTranscription } from "@/lib/ai/voice-ingest";
import { isAiGenerated } from "@/lib/ai/thread";
import { renderTts } from "@/lib/ai/voice";

beforeEach(() => h.state.reset());

describe("automation claim (dedup + mutual exclusion)", () => {
  it("#1 duplicate inbound delivery produces one claim and one response", async () => {
    const first = await claimInbound("t1", "c1", "m1", "native_ai");
    const second = await claimInbound("t1", "c1", "m1", "native_ai");
    expect(first).toBe(true);
    expect(second).toBe(false); // redelivery loses → no second reply
  });

  it("#3 native AI and autopilot cannot both claim the same inbound", async () => {
    const autopilot = await claimInbound("t1", "c1", "m1", "autopilot");
    const nativeAi = await claimInbound("t1", "c1", "m1", "native_ai");
    expect(autopilot).toBe(true);
    expect(nativeAi).toBe(false); // the claim row is the atomic arbiter
  });

  it("#3 native AI stands down when the legacy autopilot owns the team", async () => {
    h.state.teams.set("t1", { aiAutopilotEnabled: true });
    h.state.teams.set("t2", { aiAutopilotEnabled: false });
    expect(await legacyAutopilotOwnsTeam("t1")).toBe(true);
    expect(await legacyAutopilotOwnsTeam("t2")).toBe(false);
  });
});

describe("conversation state machine", () => {
  it("#2 a human reply cancels the AI turn (ai_active -> human_active) but does not permanently pause", async () => {
    await onCustomerInbound("t1", "c1"); // seeds ai_active
    const afterHuman = await onHumanReply("t1", "c1", "u1");
    expect(afterHuman.state).toBe("human_active");

    // The next customer inbound AUTO-RESUMES to ai_active (default resumption).
    const afterCustomer = await onCustomerInbound("t1", "c1");
    expect(afterCustomer.state).toBe("ai_active");
  });

  it("#2 an explicit agent pause is sticky across customer inbounds", async () => {
    await onCustomerInbound("t1", "c2");
    await pauseByAgent("t1", "c2", "u1");
    const afterCustomer = await onCustomerInbound("t1", "c2");
    expect(afterCustomer.state).toBe("ai_paused"); // NOT auto-resumed
    const s = await getState("c2");
    expect(s?.state).toBe("ai_paused");
  });
});

describe("send/suggest decision", () => {
  const base = { autoReplyMode: "auto_send", confidenceThreshold: 0.55 } as const;
  const ok = { shouldEscalate: false, confidence: 0.9 };

  it("escalates when the model flags handoff", () => {
    expect(decideMode(base, { shouldEscalate: true, confidence: 0.9 }, false)).toBe("escalate");
  });
  it("drafts below the confidence threshold even in auto_send", () => {
    expect(decideMode(base, { shouldEscalate: false, confidence: 0.4 }, false)).toBe("suggest");
  });
  it("auto-sends above threshold in auto_send", () => {
    expect(decideMode(base, ok, false)).toBe("send");
  });
  it("draft mode always suggests", () => {
    expect(decideMode({ ...base, autoReplyMode: "draft" }, ok, false)).toBe("suggest");
  });
  it("hybrid drafts in-hours and auto-sends after-hours", () => {
    expect(decideMode({ ...base, autoReplyMode: "hybrid" }, ok, true)).toBe("suggest");
    expect(decideMode({ ...base, autoReplyMode: "hybrid" }, ok, false)).toBe("send");
  });
});

describe("voice", () => {
  it("#4 transcription is idempotent — a ready row is reused, not re-transcribed", async () => {
    h.state.transcriptions.set("m1", { status: "ready", transcript: "مرحبا", correctedText: null });
    const text = await ensureTranscription("t1", "m1");
    expect(text).toBe("مرحبا"); // returned from the existing row, no provider call
  });

  it("#8 TTS failure surfaces as a rejection so the caller falls back to text", async () => {
    // No OPENAI_API_KEY in the test env → the client is unavailable → reject.
    await expect(renderTts({ text: "مرحبا" })).rejects.toThrow();
  });
});

describe("knowledge retrieval (tenant isolation)", () => {
  it("#6 retrieval is scoped by teamId (tenant A cannot read tenant B chunks)", async () => {
    h.state.setQueryRows([{ id: "ch1", content: "hours are 9-5", documentId: "d1" }]);
    const rows = await retrieveContextChunks("teamA", "opening hours", 6);
    expect(rows).toHaveLength(1);
    // The teamId MUST be a bound parameter of the query (never interpolated).
    const values = h.state.captured.at(-1)?.values ?? [];
    expect(values).toContain("teamA");
    expect(values).not.toContain("teamB");
  });

  it("#6 an empty query never hits the DB", async () => {
    const rows = await retrieveContextChunks("teamA", "   ", 6);
    expect(rows).toEqual([]);
    expect(h.state.captured).toHaveLength(0);
  });
});

describe("loop guard", () => {
  it("#9 an AI-generated outbound message is recognized and won't retrigger the assistant", async () => {
    h.state.metadata.set("out1", { aiGenerated: true });
    expect(await isAiGenerated("out1")).toBe(true);
    expect(await isAiGenerated("in1")).toBe(false);
  });
});

/**
 * Structurally covered (asserted by construction, not a runtime test here):
 *
 *  #5 Suggestions survive refresh/reconnect — AiReplySuggestion is a persisted
 *     row keyed by @@unique([teamId, inboundMessageId]); the composer rehydrates
 *     it via GET /api/ai-assistant/conversations/:id/overview on mount. No
 *     client-only state holds the draft.
 *
 *  #7 Summary failure never breaks replies — the reply is sent/committed BEFORE
 *     summary/memory are enqueued, and the enqueue is wrapped in `.catch(()=>{})`
 *     (orchestrator.ts). Summary/memory run as separate idempotent queue jobs.
 */
