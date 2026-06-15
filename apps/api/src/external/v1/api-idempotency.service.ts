import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import {
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";

import { refundApiKeyBucket } from "../../auth/api-key.guard";
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
 * `(teamId, apiKeyId, key)` unique index of `ApiIdempotencyKey`.
 *
 * Originally lived (private) inside `ExternalV1MessagingService` for the text +
 * template send paths. Extracted here so the NON-send /v1 mutations (assign,
 * status, tag add/remove, contact update) — which live in a different service —
 * reuse the EXACT same logic instead of a parallel copy. This closes F2 from
 * docs/audit-guide.md: a partner retry of an assign/tag/etc.
 * no longer re-fires the mutation + its workflow/webhook reactions.
 *
 * Usage (mirrors the send paths):
 *   const claim = await idem.claim<Result>(teamId, apiKeyId, key,
 *     idem.fingerprint("assign", { conversationId, ...input }));
 *   if (claim.kind === "replay") return claim.result;
 *   try {
 *     const result = await doTheWork();
 *     await idem.complete(teamId, apiKeyId, key, result);
 *     return result;
 *   } catch (err) {
 *     await idem.release(teamId, apiKeyId, key);
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
    teamId: string,
    apiKeyId: string,
    key: string,
    requestHash: string,
  ): Promise<IdempotencyClaim<T>> {
    const claimPending = () =>
      this.db.apiIdempotencyKey.create({
        data: {
          teamId,
          apiKeyId,
          key,
          requestHash,
          responseBody: { _pending: true } as Prisma.InputJsonValue,
          responseStatus: IDEMPOTENCY_PENDING_STATUS,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_PENDING_TTL_MS),
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
        where: { teamId_apiKeyId_key: { teamId, apiKeyId, key } },
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
        if (cached.expiresAt > new Date()) {
          throw new ConflictException({
            error: "idempotency_in_progress",
            detail:
              "A previous request with this Idempotency-Key is still in flight. " +
              "Retry in a few seconds.",
          });
        }
        // Stale pending past TTL — clear and tell the partner to re-claim.
        await this.db.apiIdempotencyKey.deleteMany({
          where: { teamId, apiKeyId, key },
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
        // request did zero real work, so it shouldn't burn quota.
        refundApiKeyBucket(apiKeyId);
        return { kind: "replay", result: cached.responseBody as unknown as T };
      }
      // Expired completed row — delete + re-claim, then proceed.
      await this.db.apiIdempotencyKey.deleteMany({
        where: { teamId, apiKeyId, key },
      });
      await claimPending();
      return { kind: "claimed" };
    }
  }

  /** Flip a claimed pending row to the completed response (24h TTL). */
  async complete<T>(
    teamId: string,
    apiKeyId: string,
    key: string,
    result: T,
  ): Promise<void> {
    try {
      await this.db.apiIdempotencyKey.update({
        where: { teamId_apiKeyId_key: { teamId, apiKeyId, key } },
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
  async release(teamId: string, apiKeyId: string, key: string): Promise<void> {
    await this.db.apiIdempotencyKey
      .deleteMany({
        where: { teamId, apiKeyId, key, responseStatus: IDEMPOTENCY_PENDING_STATUS },
      })
      .catch(() => {
        /* best-effort */
      });
  }
}
