// Note: no `server-only` import — pulled in by the BullMQ worker which boots
// from server.ts, outside the Next bundler context.

import type { WorkflowStepType, WorkflowTriggerEvent } from "@prisma/client";

import type {
  ResolverExtras,
  MessageLike,
  ConversationLike,
} from "@ccp/shared/field-tokens";

import type {
  WorkflowConversationSnapshot,
  WorkflowContactSnapshot,
  WorkflowEventEnvelope,
  WorkflowMessageSnapshot,
} from "@/lib/workflows/events";
import type { WorkflowGraph } from "@/lib/workflows/graph";

/**
 * Inbound answer dropped onto the run by the message-ingest hook when a
 * contact replies to an `ask_question` step. The step reads this on resume
 * to decide whether to take the `answered` or `timeout` edge.
 */
export interface PendingAnswer {
  body: string;
  messageId: string;
  timestamp: string;
  /** Stable machine id when the reply was an interactive button / list tap.
   *  Undefined for plain text replies. */
  optionId?: string;
  optionKind?: "button_reply" | "list_reply";
}

/**
 * Context handed to every step handler at run time. The envelope already
 * carries teamId / contact / conversation; this is the slim extras a
 * handler couldn't infer.
 */
export interface StepRunContext {
  teamId: string;
  workflowId: string;
  runId: string;
  trigger: WorkflowTriggerEvent;
  attempt: number;
  /** Current step id (for diagnostics + jump_to_step bookkeeping). */
  stepId: string;
  /** Read-only — handlers may need to peek at peers for branch/jump logic. */
  graph: WorkflowGraph;
  /** Populated by the message-ingest hook for `ask_question` steps when the
   *  contact replies. Null on the first invocation AND on the timeout
   *  resume path. */
  pendingAnswer?: PendingAnswer | null;
  /** True when this step invocation is a re-execution after a wait /
   *  await_reply pause. The handler can use it to skip the side-effecting
   *  "send the question" path and go straight to selecting the outgoing
   *  edge based on `pendingAnswer`. */
  isResume?: boolean;
}

/**
 * What a step handler returns. HTTP-shaped on purpose so we can reuse the
 * webhook idiom from the automations era ("2xx/3xx good, 4xx no-retry,
 * throw to retry"). Beyond that, three control-flow variants tell the
 * runner what to do next:
 *
 *   advance — proceed to the unlabeled outgoing edge (most steps)
 *   branch  — proceed to the edge whose label matches `selectedLabel`
 *   jump    — proceed to a specific node id (jump_to_step)
 *   wait    — schedule a resume `delayMs` from now, mark the run waiting
 *
 * Returning a 4xx + `advance` is a non-throw failure that still advances
 * the flow — useful for "tried to add a tag the team deleted, log + move
 * on" rather than dead-ending the run.
 */
export type StepResult =
  | { kind: "advance"; status: number; body: string }
  | { kind: "branch"; status: number; body: string; selectedLabel: string }
  | { kind: "jump"; status: number; body: string; targetStepId: string }
  | { kind: "wait"; status: number; body: string; delayMs: number }
  /**
   * Pause the run on the SAME step waiting for the contact's next inbound
   * message (or `timeoutMs` to elapse, whichever comes first). Unlike `wait`,
   * the runner does NOT advance `currentStepId` — when the run resumes the
   * step is re-executed, and the handler picks an outgoing edge via a
   * subsequent `branch` return. Used by `ask_question`.
   */
  | { kind: "await_reply"; status: number; body: string; timeoutMs: number };

/**
 * Whether a step's `run` produces an externally-visible side effect that
 * MUST NOT execute twice if a retry picks the same run up.
 *
 *   "irreversible" — Meta send, outbound webhook fire, tag mutation,
 *                    audit-row write. Runner journals `in_progress`
 *                    before running and treats a retry that finds the
 *                    journal as "presumed sent, advance."
 *   "pure"          — DB-read-only step types (branch, wait, jump_to_step)
 *                    and the trivial computes (advanceWithError on bad
 *                    config). Safe to re-run.
 *
 * Required on every handler — adding a new step type forces the author
 * to declare its semantics at the type-system level. The earlier
 * hand-maintained string list in `runner.ts` silently misclassified
 * every new step type as "pure" until someone remembered to update it,
 * which is the exact shape of bug CLAUDE.md rule #3 exists to prevent.
 */
export type StepSideEffect = "irreversible" | "pure";

export interface StepHandler<C = unknown> {
  type: WorkflowStepType;
  /** See StepSideEffect. */
  sideEffect: StepSideEffect;
  /** Throws on garbage; message surfaces back to the admin via the API. */
  parseConfig(raw: unknown): C;
  redactConfig?(config: C): unknown;
  describeConfig?(config: C): string;
  run(
    envelope: WorkflowEventEnvelope,
    config: C,
    ctx: StepRunContext,
  ): Promise<StepResult>;
}

export class StepConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepConfigError";
  }
}

export function truncateBody(s: string): string {
  return s.length > 2048 ? s.slice(0, 2048) + "…[truncated]" : s;
}

/** Helper for common "did it" success results. */
export function advance(payload: unknown = {}): StepResult {
  return {
    kind: "advance",
    status: 200,
    body: truncateBody(typeof payload === "string" ? payload : JSON.stringify(payload)),
  };
}

/** Helper for 4xx "user config issue, don't retry, but advance" results. */
export function advanceWithError(status: number, error: string, detail?: string): StepResult {
  return {
    kind: "advance",
    status,
    body: truncateBody(JSON.stringify({ error, ...(detail ? { detail } : {}) })),
  };
}

/**
 * Read the conversation snapshot from an envelope, or null. Some triggers
 * (contact_tag_updated, contact_field_updated, contact_lifecycle_updated,
 * incoming_webhook) don't carry one — handlers that need a conversation
 * should advanceWithError(400) when this returns null.
 */
export function envelopeConversation(
  envelope: WorkflowEventEnvelope,
): WorkflowConversationSnapshot | null {
  const data = envelope.data as { conversation?: WorkflowConversationSnapshot | null };
  return data.conversation ?? null;
}

/**
 * Read the contact snapshot from an envelope, or null. Most triggers carry
 * one but incoming_webhook can be null until enriched by a contact-match
 * step (round 2c).
 */
export function envelopeContact(
  envelope: WorkflowEventEnvelope,
): WorkflowContactSnapshot | null {
  const data = envelope.data as { contact?: WorkflowContactSnapshot | null };
  return data.contact ?? null;
}

/**
 * Read the trigger-message snapshot from an envelope, or null. Only
 * `message_received` carries one; other triggers return null so token
 * expansion of `$var.message.*` resolves to empty.
 */
export function envelopeMessage(
  envelope: WorkflowEventEnvelope,
): WorkflowMessageSnapshot | null {
  const data = envelope.data as { message?: WorkflowMessageSnapshot };
  return data.message ?? null;
}

/**
 * Build the `extras` argument for `resolveFieldTokens` from an envelope.
 * Centralised so every step handler that expands user-authored copy ends
 * up with the same set of `$var.message.*` / `$var.conversation.*` keys
 * available. Contact stays as the explicit first argument because some
 * step handlers (notably send_message with target.kind="phone") swap the
 * trigger contact for the target contact at run time.
 */
export function envelopeExtras(
  envelope: WorkflowEventEnvelope,
): ResolverExtras {
  const message = envelopeMessage(envelope);
  const conversation = envelopeConversation(envelope);
  const extras: ResolverExtras = {};
  if (message) extras.message = message as MessageLike;
  if (conversation) extras.conversation = conversation as ConversationLike;
  return extras;
}
