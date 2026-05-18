import { Prisma, type Message } from "@prisma/client";

import { db } from "@/lib/db";
import type { ProviderName } from "@ccp/shared/types";

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
export async function createOutboundMessageIdempotent(
  data: Prisma.MessageUncheckedCreateInput,
): Promise<Message> {
  const MAX_ATTEMPTS = 5;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const created = await db.message.create({ data });
      // Race: Meta can deliver `sent`/`delivered`/`read` for the wamid
      // BEFORE this row commits. The status webhook handler parks the
      // status for ~5min; drain it here so a fast-arriving status isn't
      // dropped silently. Fire-and-forget so we don't slow the happy path.
      if (created.externalId && created.provider) {
        void drainParkedStatus(
          created.teamId,
          created.provider as ProviderName,
          created.externalId,
          created.id,
          created.conversationId,
        ).catch((err) => {
          // Failure here means a status that arrived BEFORE we committed
          // the row is now lost (we already deleted the parked entry).
          // Logging is the only recovery signal — without it the message
          // is stuck at its create-time status with no operator clue.
          console.error(
            JSON.stringify({
              event: "drainParkedStatus.failed",
              severity: "error",
              correlationId: getCorrelationId() ?? null,
              teamId: created.teamId,
              provider: created.provider,
              externalId: created.externalId,
              messageId: created.id,
              message: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            }),
          );
        });
      }
      return created;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // P2002: duplicate externalId — legitimate, return existing row.
        // Uniqueness is now compound on (teamId, provider, externalId)
        // (post the multi-channel refactor) so cross-tenant collisions
        // can't surface here in the first place; the lookup mirrors the
        // unique key.
        if (err.code === "P2002" && data.externalId && data.provider) {
          const existing = await db.message.findUnique({
            where: {
              teamId_provider_externalId: {
                teamId: data.teamId,
                provider: data.provider,
                externalId: data.externalId,
              },
            },
          });
          if (existing) return existing;
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
 * Transient DB errors worth retrying. Connection-related and serialization
 * codes; explicit deny-list of business-logic errors so we don't paper over
 * real bugs by retrying a violated FK constraint.
 */
function isTransient(err: unknown): boolean {
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
