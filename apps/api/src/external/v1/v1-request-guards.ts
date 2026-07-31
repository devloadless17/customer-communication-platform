import { HttpException } from "@nestjs/common";

import { MAX_CHAIN_DEPTH, parseChainDepth } from "@/lib/workflows/events";

/**
 * HTTP-boundary guards shared by every /v1 controller after the 2026-07-31
 * split of the 197-route ExternalV1Controller. Standalone functions (not a
 * base class) so a controller can't fork the rules by overriding them —
 * exactly the channel-guards.ts pattern the team-chat split set.
 */

/**
 * Cross-system loop guard for EVERY mutating /v1 route that publishes a
 * domain event (which can fan an outbound webhook back to the partner, who
 * may POST back here). The outbound-webhook deliverer stamps an incrementing
 * `X-CCP-Depth` on each delivery; if a request arrives already at/over the
 * cap, refuse it with 429 to break the loop. HTTP-boundary concern, so it
 * lives with the controllers — service signatures stay untouched.
 */
export function guardChainDepth(xCcpDepth: string | undefined): void {
  const depth = parseChainDepth(xCcpDepth);
  if (depth >= MAX_CHAIN_DEPTH) {
    throw new HttpException(
      {
        error: "chain_depth_exceeded",
        detail:
          `inbound X-CCP-Depth ${depth} >= ${MAX_CHAIN_DEPTH} — request dropped ` +
          "to break a likely cross-system loop.",
      },
      429,
    );
  }
}

/**
 * Normalize the inbound `Idempotency-Key` header for EVERY /v1 mutation:
 *   - trim; empty/absent → `undefined` (no idempotency, as before)
 *   - > 255 chars → 400 `idempotency_key_too_long` (Stripe convention: an
 *     invalid key errors, it does NOT silently degrade — the two send routes
 *     used to drop an over-long key, leaving the highest-risk operation with
 *     ZERO duplicate-send protection on a partner's retry-after-timeout flow).
 * 255 is the same ceiling the send routes already enforced; applying it
 * uniformly keeps the surface internally consistent.
 */
export function idemKey(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 255) {
    throw new HttpException(
      {
        error: "idempotency_key_too_long",
        detail: "Idempotency-Key must be at most 255 characters.",
      },
      400,
    );
  }
  return trimmed;
}

/**
 * Same as idemKey() but MANDATORY — for routes that send to Meta. A WhatsApp
 * send is non-idempotent (Meta assigns the wamid; we can't dedupe before the
 * call returns), bills the team, and counts against their quality rating. The
 * only thing that makes a partner's retry-after-5xx safe is a stable client
 * key, so we refuse the send without one rather than risk double-texting the
 * customer. Use a unique value per logical send (e.g. the inbound message id).
 */
export function idemKeyRequired(raw: string | undefined): string {
  const key = idemKey(raw);
  if (!key) {
    throw new HttpException(
      {
        error: "idempotency_key_required",
        detail:
          "Send an Idempotency-Key header (unique per logical send, e.g. the inbound message id) so a retry can't double-send to WhatsApp.",
      },
      400,
    );
  }
  return key;
}
