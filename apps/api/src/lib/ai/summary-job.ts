import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";

import { resolveModel } from "./models";
import { chatJson } from "./openai-client";
import { loadRecentMessages } from "./thread";

/**
 * Incremental per-session summary (correction #6). A session is open until the
 * conversation closes or 12h of inactivity; `lastSummarizedMessageId` +
 * `summaryVersion` track incremental progress. Idempotent: safe to re-run — it
 * recomputes from the prior summary + recent messages. Runs as a separate job
 * AFTER the reply is committed; never blocks the customer response (#14).
 */

const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

interface SummaryPayload {
  customerGoal: string;
  importantContext: string;
  questions: string[];
  answers: string[];
  commitments: string[];
  openQuestions: string[];
  requiredFollowUp: string;
  sentiment: string;
  language: string;
  tone: string;
  latestStatus: string;
  overallBrief: string;
}

const strArr = { type: "array", items: { type: "string" } };
const SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "customerGoal",
    "importantContext",
    "questions",
    "answers",
    "commitments",
    "openQuestions",
    "requiredFollowUp",
    "sentiment",
    "language",
    "tone",
    "latestStatus",
    "overallBrief",
  ],
  properties: {
    customerGoal: { type: "string" },
    importantContext: { type: "string" },
    questions: strArr,
    answers: strArr,
    commitments: { ...strArr, description: "Promises/commitments the company made." },
    openQuestions: { ...strArr, description: "Unanswered questions still pending." },
    requiredFollowUp: { type: "string" },
    sentiment: { type: "string" },
    language: { type: "string" },
    tone: { type: "string" },
    latestStatus: { type: "string" },
    overallBrief: {
      type: "string",
      description: "1-2 sentence brief of the WHOLE conversation/relationship across all sessions.",
    },
  },
};

export async function runSessionSummary(conversationId: string): Promise<void> {
  const conv = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { workspaceId: true, status: true },
  });
  if (!conv) return;
  const messages = await loadRecentMessages(conversationId, 80);
  if (!messages.length) return;
  const now = new Date();

  const latest = await db.conversationSessionSummary.findFirst({
    where: { conversationId },
    orderBy: { sessionStartAt: "desc" },
  });

  let openSessionId: string | null = null;
  let prior: Partial<SummaryPayload> | null = null;
  if (latest && latest.sessionEndAt === null) {
    const idle = now.getTime() - new Date(latest.updatedAt).getTime();
    if (idle <= SESSION_IDLE_MS && conv.status !== "closed") {
      openSessionId = latest.id;
      prior = {
        customerGoal: latest.customerGoal ?? "",
        importantContext: latest.importantContext ?? "",
        requiredFollowUp: latest.requiredFollowUp ?? "",
        latestStatus: latest.latestStatus ?? "",
      };
    } else {
      // Close the stale open session before starting a new one.
      await db.conversationSessionSummary.update({
        where: { id: latest.id },
        data: { sessionEndAt: latest.updatedAt },
      });
    }
  }

  // Scope the transcript to the CURRENT session ONLY — otherwise a returning
  // customer's summary bleeds in older, unrelated sessions. Boundary: the open
  // session's recorded start if one exists, else the message right after the
  // last >=12h idle gap.
  const sessionStartMs =
    openSessionId && latest
      ? new Date(latest.sessionStartAt).getTime()
      : latestSessionBoundaryMs(messages);
  const scopedAll = messages.filter(
    (m) => new Date(m.timestamp).getTime() >= sessionStartMs,
  );
  const scoped = scopedAll.length ? scopedAll : messages;

  const label = (m: (typeof scoped)[number]) =>
    `${m.direction === "in" ? "Customer" : m.aiGenerated ? "AI" : "Agent"}: ${m.body}`;
  const transcript = scoped.map(label).join("\n").slice(0, 12000);
  // The WHOLE conversation (all sessions in the recent window) — used ONLY for
  // the short overallBrief, not the session fields.
  const fullTranscript = messages.map(label).join("\n").slice(0, 8000);

  const system =
    "You maintain a VERY SHORT, factual running summary of ONE customer-support session, PLUS a brief of the whole relationship. Be terse: each session text field is a single short phrase (customerGoal ideally under 12 words), and every list holds AT MOST 2 items — keep only what an agent glancing at the panel truly needs. The session fields describe the CURRENT session only; keep transient specifics (an order number, a one-off complaint detail) there. Separately, `overallBrief` is a 1-2 sentence brief of the WHOLE conversation/relationship across all sessions (who this customer is and what they generally want/need). Return the structured fields; use empty strings/arrays where nothing applies.";
  const user = `Prior session summary (JSON, may be empty):\n${prior ? JSON.stringify(prior) : "(none)"}\n\nCURRENT session (summarize into the session fields):\n${transcript}\n\nWHOLE conversation across all sessions (for overallBrief ONLY):\n${fullTranscript}\n\nProduce the updated current-session summary AND the overall brief.`;

  const res = await chatJson<SummaryPayload>({
    model: resolveModel("summary"),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    schemaName: "session_summary",
    schema: SUMMARY_SCHEMA,
    maxTokens: 550,
  });
  if (!res.data) return;
  const p = res.data;
  const lastMessageId = scoped[scoped.length - 1]!.id;

  const fields = {
    customerGoal: p.customerGoal || null,
    importantContext: p.importantContext || null,
    questions: p.questions ?? [],
    answers: p.answers ?? [],
    commitments: p.commitments ?? [],
    openQuestions: p.openQuestions ?? [],
    requiredFollowUp: p.requiredFollowUp || null,
    sentiment: p.sentiment || null,
    language: p.language || null,
    tone: p.tone || null,
    latestStatus: p.latestStatus || null,
    overallBrief: p.overallBrief || null,
    lastSummarizedMessageId: lastMessageId,
  };

  if (openSessionId) {
    await db.conversationSessionSummary.update({
      where: { id: openSessionId },
      data: { ...fields, summaryVersion: { increment: 1 } },
    });
  } else {
    await db.conversationSessionSummary.create({
      data: {
        workspaceId: conv.workspaceId,
        conversationId,
        sessionStartAt: scoped[0]!.timestamp ?? now,
        summaryVersion: 1,
        ...fields,
      },
    });
  }

  void publish({ type: "ai.summary_changed", workspaceId: conv.workspaceId, conversationId }).catch(() => {});
}

// Messages beyond this in a selected range are dropped from the transcript
// (oldest-first truncation) — bounds worst-case prompt size the same way
// `loadRecentMessages(80)` bounds the incremental session summary above.
const MAX_RANGE_MESSAGES = 400;

/**
 * On-demand summary for an AGENT-SELECTED date range, spanning the WHOLE
 * conversation (not scoped to any one session) — distinct from the
 * incremental per-session summary above. Stateless: not persisted, no prior
 * summary carried in, since the range itself is arbitrary. Returns null when
 * there are no messages in range or the model call fails.
 */
export async function summarizeRange(
  workspaceId: string,
  conversationId: string,
  from: Date,
  to: Date,
): Promise<SummaryPayload | null> {
  const messages = await db.message.findMany({
    where: { workspaceId, conversationId, timestamp: { gte: from, lte: to } },
    orderBy: { timestamp: "asc" },
    take: MAX_RANGE_MESSAGES,
    select: { id: true, direction: true, body: true },
  });
  if (!messages.length) return null;

  const aiMeta = await db.aiMessageMetadata.findMany({
    where: { messageId: { in: messages.map((m) => m.id) }, aiGenerated: true },
    select: { messageId: true },
  });
  const aiSet = new Set(aiMeta.map((m) => m.messageId));
  const transcript = messages
    .map((m) => `${m.direction === "in" ? "Customer" : aiSet.has(m.id) ? "AI" : "Agent"}: ${m.body}`)
    .join("\n")
    .slice(0, 16000);

  const system =
    "You summarize a customer-support conversation for a SPECIFIC date range the agent selected — across the WHOLE conversation history in that window, not just the latest session. Be concise and factual. `overallBrief` is a 1-2 sentence brief of the relationship/customer as seen across the range. Return the structured fields; use empty strings/arrays where nothing applies.";
  const user = `Messages between ${from.toISOString()} and ${to.toISOString()}:\n${transcript}\n\nProduce a summary of just this period.`;

  const res = await chatJson<SummaryPayload>({
    model: resolveModel("summary"),
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    schemaName: "range_summary",
    schema: SUMMARY_SCHEMA,
    maxTokens: 550,
  });
  return res.data ?? null;
}

/** First timestamp (ms) of the CURRENT session = the message right after the
 *  last >=12h idle gap. `messages` are ascending by time. Falls back to the
 *  oldest message (whole thread is one session). */
function latestSessionBoundaryMs(messages: { timestamp: Date | string }[]): number {
  for (let i = messages.length - 1; i > 0; i--) {
    const cur = new Date(messages[i]!.timestamp).getTime();
    const prev = new Date(messages[i - 1]!.timestamp).getTime();
    if (cur - prev >= SESSION_IDLE_MS) return cur;
  }
  return messages.length ? new Date(messages[0]!.timestamp).getTime() : 0;
}
