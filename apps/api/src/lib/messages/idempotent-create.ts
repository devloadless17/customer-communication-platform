import { Prisma, type Message } from "@prisma/client";

import { db } from "@/lib/db";
import type { Channel } from "@ccp/shared/types";

import { getCorrelationId } from "@/common/correlation";
import { drainParkedStatus } from "@/lib/providers/ingest";

/**
 * CLAUDE.md rule #3: every write of a Meta wamid (`externalId`) must be
 * idempotent. Bare `db.message.create` is forbidden — the unique index throws
 * P2002 on a duplicate, which on outbound paths can happen via:
 *   - client retry after a transient 5xx from our own API
 *   - Meta returning a wamid that already exists (replay / manual repair)
 *   - two browser tabs sending the same optimistic payload
 *
 * On collision we return the EXISTING row so the caller can still emit
 * `message:new` with a real id and keep the optimistic UI flowing. Inbound
 * paths (ingest) want different semantics (silently drop on collision), so
 * they keep their own try/catch — this helper is for outbound only.
 *
 * Retry policy: outbound callers reach this AFTER Meta has accepted the
 * send. From that moment the customer has the message; failing to persist
 * locally creates a ghost where the agent's UI doesn't match what was sent.
 * We retry transient DB errors (connection drops, deadlocks, pool timeouts)
 * up to 5 times with exponential backoff (~3s total) — enough to ride out
 * a Postgres restart or a brief connection blip without leaking the
 * "send-without-persist" gap to the UI.
 */
/**
 * Optional tx client — when provided, the Message INSERT participates in the
 * caller's transaction so the row commits atomically with sibling writes
 * (e.g. `OutboundSendAttempt.completedAt` stamping). When omitted, falls
 * back to the global `db` client and the legacy retry-with-backoff path.
 *
 * Inside a tx the retry loop is COLLAPSED to a single attempt: Postgres
 * doesn't let you retry inside a single tx anyway (failure rolls back the
 * outer scope), and the caller's own tx-retry policy (if any) is the right
 * place to handle transient DB errors.
 */
type TxOrDb = Prisma.TransactionClient | typeof db;

/**
 * `created: false` means the row already existed — a raced duplicate of the same
 * `externalId`. Callers that publish domain events off the back of the insert
 * MUST check it: a webhook-driven path (an echo re-delivered by Meta) otherwise
 * fans out `message.sent` twice for one message, minting two outbound-webhook
 * deliveries and double-counting analytics.
 */
export interface IdempotentCreateResult {
  message: Message;
  created: boolean;
}

/** Convenience wrapper for callers that don't care whether it was a dedup hit. */
export async function createOutboundMessageIdempotent(
  data: Prisma.MessageUncheckedCreateInput,
  txOrDb?: TxOrDb,
): Promise<Message> {
  return (await createOutboundMessageIdempotentDetailed(data, txOrDb)).message;
}

export async function createOutboundMessageIdempotentDetailed(
  data: Prisma.MessageUncheckedCreateInput,
  txOrDb?: TxOrDb,
): Promise<IdempotentCreateResult> {
  // Tx path: single attempt, P2002 still returns existing row, no retry.
  // The drain-parked-status fire-and-forget normally happens here too,
  // but inside a tx it could try to drain BEFORE the row commits — and a
  // racing status webhook would re-park because the message isn't visible
  // yet. Defer the drain to AFTER tx commit via a microtask scheduled
  // post-return; by the time the microtask runs, the caller will have
  // exited the tx scope (Prisma `$transaction` resolves only after commit).
  if (txOrDb && txOrDb !== db) {
    let created: Message;
    try {
      created = await (txOrDb as Prisma.TransactionClient).message.create({ data });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" &&
        data.externalId &&
        data.channel
      ) {
        const existing = await (txOrDb as Prisma.TransactionClient).message.findUnique({
          where: {
            teamId_channel_externalId: {
              teamId: data.teamId,
              channel: data.channel,
              externalId: data.externalId,
            },
          },
        });
        if (existing) return { message: existing, created: false };
      }
      throw err;
    }
    if (created.externalId && created.channel) {
      // Run on the next macrotask so the tx has fully committed by the
      // time `drainWithRetry` reads the row. A microtask would still be
      // INSIDE the tx's pending promise chain — the drain would race
      // a row that isn't visible to other connections yet.
      const c = created;
      setTimeout(() => {
        void (async () => {
          const convo = await db.conversation.findUnique({
            where: { id: c.conversationId },
            select: { contactId: true },
          });
          if (convo) {
            void drainWithRetry(
              c.teamId,
              c.channel as Channel,
              c.externalId,
              c.id,
              c.conversationId,
              convo.contactId,
            );
          }
        })();
      }, 0);
    }
    return { message: created, created: true };
  }

  const MAX_ATTEMPTS = 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const created = await db.message.create({ data });
      // Race: Meta can deliver `sent`/`delivered`/`read` for the wamid
      // BEFORE this row commits. The status webhook handler parks the
      // status for ~5min; drain it here so a fast-arriving status isn't
      // dropped silently. Fire-and-forget so we don't slow the happy path.
      // One retry on transient failure — a Redis hiccup at exactly this
      // millisecond would otherwise lose the parked status (GETDEL is
      // atomic, so by the time the catch runs the entry is already gone).
      if (created.externalId && created.channel) {
        // contactId lookup is unconditional but cheap (indexed PK) — needed
        // so the parked-status publish carries contact_id for outbound webhooks.
        const convo = await db.conversation.findUnique({
          where: { id: created.conversationId },
          select: { contactId: true },
        });
        if (convo) {
          void drainWithRetry(
            created.teamId,
            created.channel as Channel,
            created.externalId,
            created.id,
            created.conversationId,
            convo.contactId,
          );
        }
      }
      return { message: created, created: true };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // P2002: duplicate externalId — legitimate, return existing row.
        // Uniqueness is now compound on (teamId, channel, externalId)
        // (post the multi-channel refactor) so cross-tenant collisions
        // can't surface here in the first place; the lookup mirrors the
        // unique key.
        if (err.code === "P2002" && data.externalId && data.channel) {
          const existing = await db.message.findUnique({
            where: {
              teamId_channel_externalId: {
                teamId: data.teamId,
                channel: data.channel,
                externalId: data.externalId,
              },
            },
          });
          if (existing) return { message: existing, created: false };
          throw err;
        }
      }

      lastErr = err;
      if (!isTransient(err) || attempt === MAX_ATTEMPTS - 1) {
        throw err;
      }
      // Exponential backoff with jitter: 100, 200, 400, 800ms. Jitter
      // prevents synchronized retries across concurrent requests from
      // dog-piling Postgres at exactly the same offsets.
      const base = 100 * 2 ** attempt;
      const jitter = Math.random() * base * 0.25;
      await new Promise((r) => setTimeout(r, base + jitter));
    }
  }
  // Unreachable — last iteration either returns or throws.
  throw lastErr ?? new Error("createOutboundMessageIdempotent: retries exhausted");
}

/**
 * Drain the parked status with one retry on failure. Drain itself does
 * `Redis.GETDEL` atomically — a failure means either Redis was briefly
 * unreachable (transient: retry helps) or the subsequent DB update threw
 * (persistent: retry will fail again, then we log and move on). One sleep
 * + retry catches the Redis-blip case at near-zero cost. Logged loudly on
 * final failure so ops has a recovery signal — without the log the message
 * is stuck at its create-time status with no operator clue.
 */
async function drainWithRetry(
  teamId: string,
  channel: Channel,
  externalId: string,
  messageId: string,
  conversationId: string,
  contactId: string,
): Promise<void> {
  try {
    await drainParkedStatus(teamId, channel, externalId, messageId, conversationId, contactId);
    return;
  } catch (firstErr) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await drainParkedStatus(teamId, channel, externalId, messageId, conversationId, contactId);
      return;
    } catch (secondErr) {
      console.error(
        JSON.stringify({
          event: "drainParkedStatus.failed",
          severity: "error",
          correlationId: getCorrelationId() ?? null,
          teamId,
          channel,
          externalId,
          messageId,
          firstAttemptMessage: firstErr instanceof Error ? firstErr.message : String(firstErr),
          message: secondErr instanceof Error ? secondErr.message : String(secondErr),
          stack: secondErr instanceof Error ? secondErr.stack : undefined,
        }),
      );
    }
  }
}

/**
 * Transient DB errors worth retrying. Connection-related and serialization
 * codes; explicit deny-list of business-logic errors so we don't paper over
 * real bugs by retrying a violated FK constraint.
 */
export function isTransient(err: unknown): boolean {
  if (
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError
  ) {
    return true;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P1001 cannot reach DB, P1002 timed out, P1008 ops timed out,
    // P1017 server closed connection, P2024 timed out fetching a
    // connection from the pool, P2034 serialization failure.
    return ["P1001", "P1002", "P1008", "P1017", "P2024", "P2034"].includes(err.code);
  }
  // PrismaClientUnknownRequestError wraps low-level driver errors —
  // usually a connection blip. Worth one more try.
  if (err instanceof Prisma.PrismaClientUnknownRequestError) return true;
  return false;
}
