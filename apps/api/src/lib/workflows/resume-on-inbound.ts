// Inbound-message → ask_question resume bridge.
//
// On every successful inbound-message commit, the ingest path calls
// `findAndConsumeAwaitingReplies()` INSIDE its transaction to find any
// `ask_question` step paused on this (teamId, contactId), drop the answer
// onto each run's `pendingAnswer`, and delete the awaiting rows. The
// caller then enqueues the resume jobs AFTER the tx commits so the worker
// can pick up the run knowing the message row + pendingAnswer are both
// already visible.
//
// One contact can be awaiting in multiple workflow runs simultaneously
// (different workflows, or the same workflow racing). Resume all of them.
//
// The transaction client is passed in so the read + write + caller's outbox
// row all live in a single atomic boundary. Without that, a crash between
// the awaiting-row read and the outbox publish would silently drop the
// resume request — Meta's webhook retry would hit our P2002 dedupe and
// never re-fire the trigger.

import { type Prisma } from "@prisma/client";

export interface InboundAnswer {
  body: string;
  messageId: string;
  /** ISO string. */
  timestamp: string;
  /** Author-assigned id when the reply was an interactive button / list tap.
   *  Round-trips through to the workflow envelope so the ask_question step
   *  can match on a stable id instead of the user-facing title. */
  optionId?: string;
  optionKind?: "button_reply" | "list_reply";
}

/**
 * Find every `WorkflowAwaitingReply` row for (teamId, contactId), update the
 * corresponding `WorkflowRun.pendingAnswer`, delete the awaiting rows, and
 * return the run ids so the caller can enqueue immediate resumes after the
 * outer tx commits.
 */
export async function findAndConsumeAwaitingReplies(
  tx: Prisma.TransactionClient,
  args: { teamId: string; contactId: string; answer: InboundAnswer },
): Promise<string[]> {
  const rows = await tx.workflowAwaitingReply.findMany({
    where: { teamId: args.teamId, contactId: args.contactId },
    select: { id: true, runId: true },
  });
  if (rows.length === 0) return [];
  // Drop the answer onto each run, then delete the awaiting rows. Using
  // updateMany via $transaction would let us batch, but the per-run write
  // is narrower (no risk of cross-run drift) and the cardinality is tiny
  // (typically 1 row, rarely 2-3).
  // Cast to InputJsonValue — InboundAnswer is structurally JSON-safe but
  // Prisma's typed JsonInput rejects narrow interfaces without an index
  // signature. The shape is enforced at the resolver site (ask_question
  // step reads `run.pendingAnswer` as `PendingAnswer | null`).
  const answerJson = args.answer as unknown as Prisma.InputJsonValue;
  for (const r of rows) {
    await tx.workflowRun.update({
      where: { id: r.runId },
      data: { pendingAnswer: answerJson },
    });
  }
  await tx.workflowAwaitingReply.deleteMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
  return rows.map((r) => r.runId);
}
