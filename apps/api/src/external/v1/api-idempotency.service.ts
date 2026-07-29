import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import {
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";

import { refundApiKeyBucket } from "../../auth/api-key.guard";
import { markIdempotentReplay } from "../../common/correlation";
import { DbService } from "../../db/db.service";

// Idempotency claim sentinels — shared by EVERY /v1 mutation (sends + assign +
// status + tag ops + contact update) so the flows can't drift. `responseStatus:
// 0` marks a pending claim; a crashed handler's pending row is GC'd after
// PENDING_TTL by the sweeper at lib/sweepers/api-idempotency-cleanup. Completed
// rows live COMPLETED_TTL.
const IDEMPOTENCY_PENDING_STATUS = 0;
const IDEMPOTENCY_PENDING_TTL_MS = 5 * 60_000;
const IDEMPOTENCY_COMPLETED_TTL_MS = 24 * 60 * 60_000;

export type IdempotencyClaim<T> =
  | { kind: "claimed" }
  | { kind: "replay"; result: T };

/**
 * Stripe-style CLAIM-then-execute idempotency on the
 * `(workspaceId, apiKeyId, key)` unique index of `ApiIdempotencyKey`.
 *
 * Originally lived (private) inside `ExternalV1MessagingService` for the text +
 * template send paths. Extracted here so the NON-send /v1 mutations (assign,
 * status, tag add/remove, contact update) — which live in a different service —
 * reuse the EXACT same logic instead of a parallel copy. This closes F2 from
 * tests/VERIFICATION-2026-07-29.md: a partner retry of an assign/tag/etc.
 * no longer re-fires the mutation + its workflow/webhook reactions.
 *
 * Usage (mirrors the send paths):
 *   const claim = await idem.claim<Result>(workspaceId, apiKeyId, key,
 *     idem.fingerprint("assign", { conversationId, ...input }));
 *   if (claim.kind === "replay") return claim.result;
 *   try {
 *     const result = await doTheWork();
 *     await idem.complete(workspaceId, apiKeyId, key, result);
 *     return result;
 *   } catch (err) {
 *     await idem.release(workspaceId, apiKeyId, key);
 *     throw err;
 *   }
 *
 * For mutations with no meaningful body to replay, complete() with a small
 * `{ ok: true }` sentinel — the replay still short-circuits the side effects,
 * which is the whole point.
 */
@Injectable()
export class ApiIdempotencyService {
  private readonly logger = new Logger(ApiIdempotencyService.name);

  constructor(private readonly db: DbService) {}

  /**
   * SHA-256 of a canonical request. `payload` is the already-Zod-parsed input
   * (stable key order for a given route), so a plain JSON.stringify is
   * deterministic — two identical requests hash equal, two different payloads
   * under the same key hash differently. The `route` prefix keeps distinct
   * mutation types under the same key apart (assign vs status vs tag).
   */
  fingerprint(route: string, payload: unknown): string {
    return createHash("sha256")
      .update(`${route}\n${JSON.stringify(payload)}`)
      .digest("hex");
  }

  /**
   * Returns:
   *   - { kind: "claimed" }       → caller OWNS a pending sentinel row and MUST
   *                                 resolve it (`complete` on success, `release`
   *                                 on failure) before returning. Proceed.
   *   - { kind: "replay", result } → a prior identical request already
   *                                 completed; return it verbatim (zero side
   *                                 effects, API-key token refunded).
   *
   * Throws ConflictException(409) when a concurrent request with the same key
   * is still in flight; UnprocessableEntity(422) on key-reuse with a different
   * payload (Stripe-style).
   */
  async claim<T>(
    workspaceId: string,
    apiKeyId: string,
    key: string,
    requestHash: string,
    /**
     * For IRREVERSIBLE operations (Meta sends). A crashed handler can leave a
     * pending row AFTER the provider already accepted the send — we record the
     * wamid only after `sendText` returns, so a crash in that gap leaves no
     * recovery breadcrumb. With this flag a stale-past-TTL pending row is NOT
     * auto-cleared for a re-claim (which would re-send a billed message); the
     * partner must use a FRESH key to deliberately resend (OUTBOUND-1). Safe
     * non-send mutations (assign/tag/status) leave it false → clear + retry.
     */
    opts?: { refuseStaleOnAmbiguity?: boolean },
  ): Promise<IdempotencyClaim<T>> {
    // I-6: an ambiguity-protected (irreversible-send) claim must OUTLIVE its
    // in-flight window so the "use a fresh Idempotency-Key" verdict survives the
    // hourly idempotency sweeper. The sweeper GCs on expiresAt, so we set
    // expiresAt to the COMPLETED TTL (24h) for these rows and track the shorter
    // in-flight deadline separately in `_inflightUntil`. Without this, once the
    // sweeper deleted the stale pending row (5min), a retry of the SAME key found
    // nothing and silently re-sent — defeating the guarantee. Safe (clearable)
    // claims keep the short PENDING TTL so they GC + allow a clean retry at 5min.
    const ambiguityProtected = opts?.refuseStaleOnAmbiguity === true;
    const claimPending = () =>
      this.db.apiIdempotencyKey.create({
        data: {
          workspaceId,
          apiKeyId,
          key,
          requestHash,
          responseBody: (ambiguityProtected
            ? { _pending: true, _inflightUntil: Date.now() + IDEMPOTENCY_PENDING_TTL_MS }
            : { _pending: true }) as Prisma.InputJsonValue,
          responseStatus: IDEMPOTENCY_PENDING_STATUS,
          expiresAt: new Date(
            Date.now() +
              (ambiguityProtected
                ? IDEMPOTENCY_COMPLETED_TTL_MS
                : IDEMPOTENCY_PENDING_TTL_MS),
          ),
        },
      });
    try {
      await claimPending();
      return { kind: "claimed" };
    } catch (err) {
      if (
        !(err instanceof Prisma.PrismaClientKnownRequestError) ||
        err.code !== "P2002"
      ) {
        throw err;
      }
      // Another request already claimed this key. Read its state.
      const cached = await this.db.apiIdempotencyKey.findUnique({
        where: { workspaceId_apiKeyId_key: { workspaceId, apiKeyId, key } },
        select: {
          responseBody: true,
          responseStatus: true,
          expiresAt: true,
          requestHash: true,
        },
      });
      if (!cached) {
        // Vanished between P2002 and the read (sweeper / manual delete).
        throw new ConflictException({
          error: "idempotency_in_progress",
          detail: "Concurrent retry race — try again in a moment.",
        });
      }
      if (cached.responseStatus === IDEMPOTENCY_PENDING_STATUS) {
        // Drive in-flight-vs-stale off the ROW's own marker, not the current
        // request's opts: an ambiguity-protected row stores its short in-flight
        // deadline in `_inflightUntil` and is RETAINED (expiresAt = 24h) past it
        // so the verdict survives the sweeper (I-6). Safe rows use expiresAt.
        const body = cached.responseBody as { _inflightUntil?: number } | null;
        const ambiguityProtectedRow = typeof body?._inflightUntil === "number";
        const inflightUntil = ambiguityProtectedRow
          ? new Date(body!._inflightUntil!)
          : cached.expiresAt;
        if (inflightUntil > new Date()) {
          throw new ConflictException({
            error: "idempotency_in_progress",
            detail:
              "A previous request with this Idempotency-Key is still in flight. " +
              "Retry in a few seconds.",
          });
        }
        // Past the in-flight window.
        if (ambiguityProtectedRow) {
          // Irreversible send: the prior request may have ALREADY reached Meta
          // (crash after `sendText` returned, before we recorded the wamid). Do
          // NOT clear + allow a re-claim — that re-sends a billed message to a
          // real customer. The row is RETAINED until its 24h expiresAt, so EVERY
          // retry of this key within that window gets this same verdict instead
          // of silently re-sending once the sweeper deleted it (OUTBOUND-1 / I-6).
          throw new ConflictException({
            error: "idempotency_ambiguous",
            detail:
              "A previous request with this Idempotency-Key did not confirm and " +
              "may have already been sent. Use a NEW Idempotency-Key to send again.",
          });
        }
        // Non-irreversible mutation — safe to clear + re-run.
        await this.db.apiIdempotencyKey.deleteMany({
          where: { workspaceId, apiKeyId, key },
        });
        throw new ConflictException({
          error: "idempotency_in_progress",
          detail: "Stale pending claim cleared — retry.",
        });
      }
      if (cached.expiresAt > new Date()) {
        // Same key reused for a DIFFERENT request — reject (Stripe-style 422)
        // rather than returning the prior response, which would silently drop
        // the new mutation. Legacy rows have a null requestHash → skip the
        // check and replay as before.
        if (cached.requestHash && cached.requestHash !== requestHash) {
          throw new UnprocessableEntityException({
            error: "idempotency_key_reuse",
            detail:
              "This Idempotency-Key was already used with a different request payload. " +
              "Use a fresh key per distinct request.",
          });
        }
        // Completed + still fresh — replay. Refund the API-key token: the
        // request did zero real work, so it shouldn't burn quota. minor#9: also
        // flag the request so the rate-limit interceptor refunds the tighter
        // per-route bucket it consumed (the api-key guard bucket alone wasn't
        // enough — a same-key crash-retry loop still burned the per-route quota).
        refundApiKeyBucket(apiKeyId);
        markIdempotentReplay();
        return { kind: "replay", result: cached.responseBody as unknown as T };
      }
      // Expired completed row — atomically flip it into a FRESH pending claim
      // via a CAS guarded on the stale expiresAt, so exactly one racer wins.
      // A non-atomic deleteMany+create leaves a delete-AFTER-create hole: racer
      // B's deleteMany could drop racer A's just-created fresh pending row,
      // letting BOTH proceed and double-fire a billed Meta send. The updateMany
      // takes a row lock and re-checks `expiresAt < now`, so the loser matches 0
      // rows (the winner already pushed expiresAt into the future).
      const now = Date.now();
      const reclaimed = await this.db.apiIdempotencyKey.updateMany({
        where: { workspaceId, apiKeyId, key, expiresAt: { lt: new Date(now) } },
        data: {
          requestHash,
          responseBody: (ambiguityProtected
            ? { _pending: true, _inflightUntil: now + IDEMPOTENCY_PENDING_TTL_MS }
            : { _pending: true }) as Prisma.InputJsonValue,
          responseStatus: IDEMPOTENCY_PENDING_STATUS,
          expiresAt: new Date(
            now +
              (ambiguityProtected
                ? IDEMPOTENCY_COMPLETED_TTL_MS
                : IDEMPOTENCY_PENDING_TTL_MS),
          ),
        },
      });
      if (reclaimed.count === 0) {
        // Lost the reclaim race (another retry already flipped the row into its
        // own fresh pending claim, or the row was swept). Same 409 every other
        // contention path returns instead of leaking a 500.
        throw new ConflictException({
          error: "idempotency_in_progress",
          detail: "Concurrent retry race — try again in a moment.",
        });
      }
      return { kind: "claimed" };
    }
  }

  /** Flip a claimed pending row to the completed response (24h TTL). */
  async complete<T>(
    workspaceId: string,
    apiKeyId: string,
    key: string,
    result: T,
  ): Promise<void> {
    try {
      await this.db.apiIdempotencyKey.update({
        where: { workspaceId_apiKeyId_key: { workspaceId, apiKeyId, key } },
        data: {
          responseBody: result as unknown as Prisma.InputJsonValue,
          responseStatus: 200,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_COMPLETED_TTL_MS),
        },
      });
    } catch (err) {
      // Row should exist (we just claimed it). If the sweeper got aggressive,
      // log + continue so the partner still gets their success response.
      this.logger.warn(
        `idempotency-key completion failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Release a claimed pending row on failure so a retry can re-claim fresh. */
  async release(workspaceId: string, apiKeyId: string, key: string): Promise<void> {
    await this.db.apiIdempotencyKey
      .deleteMany({
        where: { workspaceId, apiKeyId, key, responseStatus: IDEMPOTENCY_PENDING_STATUS },
      })
      .catch(() => {
        /* best-effort */
      });
  }
}
