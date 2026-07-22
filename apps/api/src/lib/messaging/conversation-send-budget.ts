import { createTokenBucket } from "@/common/token-bucket";

/**
 * Per-conversation send-rate ceiling. A second axis on top of the per-API-key
 * (60/min) and per-user (60/min on `messages.send`) buckets so a partner-side
 * loop — partner POSTs to `/v1/messages` → our `message.sent` triggers an
 * outbound webhook to the same partner → partner reacts and POSTs again, etc.
 * — burns into a per-thread cap that's far below "infinite" before the
 * per-key budget bites.
 *
 * 30 sends/min/conversation is generous for any human-driven thread (one
 * agent + one customer rarely exceeds 5/min in real conversation) while
 * still bounding a runaway integration to ~1k sends/hour/thread instead
 * of the 3.6k/hour the per-key cap alone allows.
 *
 * Consumed at every customer-facing send entry point (grep `consumeConversationSendBudget`):
 *   - the UI `messages.send` HTTP path        (messages.service.ts)
 *   - the external `/v1/messages` send         (external-v1-messaging.service.ts)
 *   - the workflow `send_message` step         (steps/send-message.ts)
 *   - the workflow `send_template` step        (steps/send-template.ts)
 *   - the workflow `ask_question` step         (steps/ask-question.ts)
 *
 * The workflow steps were wired in the 2026-05-22 event-safety audit — they
 * were previously the unmetered leg of the partner/integration feedback-loop
 * class (an auto-reply loop reached Meta with no per-thread ceiling). A
 * rate-limited workflow send records a clean 429 step result and advances
 * rather than throwing, so the cap stops a loop without stalling the run.
 *
 * Deliberately NOT consumed by the broadcast runner — broadcasts intentionally
 * drive many distinct threads at one send each, so a per-conversation ceiling
 * is the wrong axis there (each recipient is a different conversation). UI/v1
 * template + media + forward sends remain on their own controller-level
 * per-key / per-user buckets.
 *
 * Single-process by design (CLAUDE.md: one VPS). Moves to Redis on the
 * same trigger as every other in-process bucket — second app instance.
 */
const PER_CONVERSATION_PER_MIN = 30;

const bucket = createTokenBucket({
  perMin: PER_CONVERSATION_PER_MIN,
  // Cap on distinct (team, conversation) pairs cached. At pilot scale
  // (<= 1k active threads) this is comfortably above ceiling; at the
  // multi-tenant cliff this gets evicted LRU-ish like its siblings.
  maxKeys: 50_000,
});

export class ConversationSendRateLimitedError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter: number) {
    super(
      `conversation send budget exhausted (${PER_CONVERSATION_PER_MIN} sends/min/conversation)`,
    );
    this.name = "ConversationSendRateLimitedError";
    this.retryAfter = retryAfter;
  }
}

/**
 * Consume one send-budget token for the (team, conversation). Throws on
 * hit so the caller's existing error handling translates to a 429 with
 * Retry-After. Caller MUST hold the budget before calling Meta — once
 * Meta accepts, you've already spent customer-facing reputation.
 */
export function consumeConversationSendBudget(
  workspaceId: string,
  conversationId: string,
): void {
  const result = bucket.consume(`${workspaceId}:${conversationId}`);
  if (!result.ok) throw new ConversationSendRateLimitedError(result.retryAfter);
}
