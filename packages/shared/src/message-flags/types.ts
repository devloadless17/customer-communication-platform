/**
 * Message flags — per-message triage markers with a resolution lifecycle.
 *
 * An agent (later: the AI, a workflow, or a /v1 partner) marks ONE MESSAGE as
 * a "Complaint" / "Refund request" / "Bug report", and the team comes back to
 * it later and closes it out. Distinct from `Tag`, which labels a CONTACT and
 * feeds broadcast audience targeting — see the schema comment on
 * `MessageFlagDefinition` for why they are separate tables.
 *
 * Framework-agnostic wire shapes only. The DB models live in
 * prisma/schema.prisma; the domain logic in apps/api/src/lib/message-flags.
 */

/**
 * Lifecycle of a raised flag.
 *  - `open`      — still needs follow-up. The ONLY state that counts toward
 *                  `Conversation.openFlagCount` and appears in the queue.
 *  - `resolved`  — it was a genuine one AND it was handled.
 *  - `dismissed` — it was NOT actually one (a mis-flag, or the AI got it
 *                  wrong). Kept separate from `resolved` so "how many
 *                  complaints did we get" never counts the non-complaints.
 */
export type MessageFlagStatus = "open" | "resolved" | "dismissed";

/** Every status, in queue-display order. Iterate this, never a literal array. */
export const MESSAGE_FLAG_STATUSES: readonly MessageFlagStatus[] = [
  "open",
  "resolved",
  "dismissed",
] as const;

/**
 * Who raised the flag. A plain string union rather than a DB enum because this
 * is provenance metadata, not behaviour — a new source must not need a
 * migration. Nothing branches on it beyond rendering a source chip.
 *  - `human`    — an agent, from the inbox
 *  - `ai`       — the AI assistant while handling the conversation
 *  - `workflow` — a workflow step
 *  - `api`      — an external /v1 integration
 */
export type MessageFlagSource = "human" | "ai" | "workflow" | "api";

export const MESSAGE_FLAG_SOURCES: readonly MessageFlagSource[] = [
  "human",
  "ai",
  "workflow",
  "api",
] as const;

export function isMessageFlagSource(v: string): v is MessageFlagSource {
  return (MESSAGE_FLAG_SOURCES as readonly string[]).includes(v);
}

/**
 * A flag kind the team can raise. Team-scoped catalog managed in Settings.
 *
 * `color` is a named slot from TAG_COLORS (`"rose"`, `"amber"`, …), NOT a hex —
 * the UI maps it to a safelist of Tailwind classes without dynamic class
 * strings. Shared with contact tags on purpose: one color vocabulary.
 */
export interface MessageFlagDefinition {
  id: string;
  name: string;
  color: string;
  /** Helper text in the picker — "what does this one mean". */
  description: string | null;
  /**
   * Soft-retired. Archived definitions vanish from the picker but keep
   * rendering on existing flags and in the audit timeline, so history stays
   * readable. A definition is only hard-deletable while it has zero flags.
   */
  archived: boolean;
  sortOrder: number;
}

/**
 * The definition as the settings screen sees it — with usage counts so the UI
 * can warn "12 open flags use this" before an archive, and disable Delete when
 * the count is non-zero (the server enforces it regardless).
 */
export interface MessageFlagDefinitionWithUsage extends MessageFlagDefinition {
  totalCount: number;
  openCount: number;
}

/**
 * One raised flag, as rendered on a message bubble.
 *
 * The definition is INLINED (not just `definitionId`) so a bubble renders
 * without the client holding the catalog — the thread payload and the realtime
 * frame are both self-sufficient, per the "carry enough context to react
 * without a re-read" event rule.
 */
export interface MessageFlag {
  id: string;
  messageId: string;
  conversationId: string;
  definition: MessageFlagDefinition;
  status: MessageFlagStatus;
  source: MessageFlagSource;
  /** 0..1 for AI-raised flags; null for every other source. */
  confidence: number | null;
  /** Why it was raised. */
  note: string | null;
  createdById: string | null;
  /** Resolved server-side so the bubble doesn't need the team roster. */
  createdByName: string | null;
  /**
   * Who owns following this up. Independent of the conversation's assignee —
   * a thread can belong to one agent while a specific complaint on it is owned
   * by another.
   */
  assignedToId: string | null;
  assignedToName: string | null;
  resolvedById: string | null;
  resolvedByName: string | null;
  /** ISO. Null while `status` is `open`. */
  resolvedAt: string | null;
  resolutionNote: string | null;
  /** ISO. */
  createdAt: string;
  /** ISO. */
  updatedAt: string;
}

/**
 * A queue row — a flag plus just enough conversation context to triage it
 * without opening the thread. Selected in one query (no N+1) by
 * `listFlags` in apps/api/src/lib/message-flags/queries.ts.
 */
export interface MessageFlagQueueItem extends MessageFlag {
  contactId: string;
  contactName: string;
  /** The flagged message's own text (or media caption), truncated server-side. */
  messageExcerpt: string;
  /** ISO time of the flagged message itself — not of the flag. */
  messageTimestamp: string;
  /** The conversation's channel, for the queue row's channel glyph. */
  channel: string;
}

/** Per-definition queue counts for the rail badges. */
export interface MessageFlagCounts {
  /** Open flags across the whole team — the headline badge. */
  totalOpen: number;
  /** Open flags assigned to the requesting user. */
  mineOpen: number;
  /** Open count keyed by definition id. Definitions with zero are omitted. */
  openByDefinition: Record<string, number>;
}
