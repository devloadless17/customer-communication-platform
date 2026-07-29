/**
 * Outbound-webhook signing — the partner's ONLY integrity guarantee.
 *
 * Found uncovered while walking the outbound-webhooks invariant checklist
 * (verification program, 2026-07-29). Every other invariant in that domain had
 * a test; this one — the published wire contract every integration verifies
 * against — had none, and its failure mode is the worst kind: a silent format
 * change breaks EVERY partner's verification simultaneously, on a path where
 * our own delivery keeps returning 200 because we never check our own
 * signature. Nothing in the system would notice.
 *
 * So these assert the CONTRACT as documented (`X-CCP-Signature: t=…,v1=…`,
 * HMAC-SHA256 over `<timestamp>.<raw body>`), not merely that some digest is
 * produced. The independent recomputation below is deliberately written the way
 * a RECEIVER would write it, from the documented format — if it drifts from the
 * implementation, that IS the break.
 *
 *   pnpm --filter @ccp/api exec vitest run test/webhook-signing.spec.ts
 */
import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  WEBHOOK_WIRE_VERSION,
  generateWebhookSecret,
  signWebhookBody,
} from "@/lib/outbound-webhooks/signing";

const SECRET = "ccp_whsec_test_secret_value";
const BODY = JSON.stringify({ event_type: "message.sent", v: 1, nested: { a: [1, 2] } });

describe("signWebhookBody", () => {
  it("emits the documented header format", () => {
    const sig = signWebhookBody(SECRET, BODY, 1_700_000_000);
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(sig.startsWith("t=1700000000,")).toBe(true);
  });

  it("matches what a RECEIVER computes from the published format", () => {
    // Written from the docblock, not from the implementation: HMAC-SHA256 over
    // `<timestamp>.<raw body>`, hex. This is the assertion that actually
    // protects partners — a change to the signed string (dropping the dot,
    // signing the object instead of the bytes, switching to base64) still
    // produces a well-formed `t=…,v1=…` header and would pass the shape test
    // above while breaking every integration in the field.
    const ts = 1_700_000_000;
    const expected = createHmac("sha256", SECRET).update(`${ts}.${BODY}`).digest("hex");
    expect(signWebhookBody(SECRET, BODY, ts)).toBe(`t=${ts},v1=${expected}`);
  });

  it("covers the EXACT bytes posted — a re-serialized body must not verify", () => {
    // The docblock's warning made executable: the digest covers the raw string
    // we POST, so a receiver that re-serializes the parsed object and gets
    // different whitespace computes a different digest. Proving the two differ
    // is what stops someone "helpfully" signing an object instead of the bytes.
    const reserialized = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(reserialized).not.toBe(BODY);
    expect(signWebhookBody(SECRET, reserialized, 1_700_000_000)).not.toBe(
      signWebhookBody(SECRET, BODY, 1_700_000_000),
    );
  });

  it("is deterministic for a pinned timestamp and varies with the secret", () => {
    expect(signWebhookBody(SECRET, BODY, 42)).toBe(signWebhookBody(SECRET, BODY, 42));
    expect(signWebhookBody("other-secret", BODY, 42)).not.toBe(
      signWebhookBody(SECRET, BODY, 42),
    );
  });

  it("binds the timestamp into the digest, so a replayed header cannot be re-stamped", () => {
    // The timestamp is what lets a receiver reject stale deliveries. If it were
    // merely prepended rather than SIGNED, an attacker could replay an old body
    // with a fresh `t=` and it would still verify.
    const a = signWebhookBody(SECRET, BODY, 1_700_000_000);
    const b = signWebhookBody(SECRET, BODY, 1_700_000_060);
    expect(a.split(",v1=")[1]).not.toBe(b.split(",v1=")[1]);
  });

  it("defaults the timestamp to now, in SECONDS not milliseconds", () => {
    // A ms timestamp still matches /^t=\d+/ but puts every delivery ~55,000
    // years in the future, so every receiver enforcing a freshness window
    // rejects the lot.
    const sig = signWebhookBody(SECRET, BODY);
    const t = Number(/^t=(\d+),/.exec(sig)![1]);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(Math.abs(nowSec - t)).toBeLessThan(5);
  });
});

describe("generateWebhookSecret", () => {
  it("carries the documented prefix partners pattern-match on", () => {
    expect(generateWebhookSecret().startsWith("ccp_whsec_")).toBe(true);
  });

  it("is unique per call and long enough for HMAC-SHA256", () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateWebhookSecret()));
    expect(secrets.size).toBe(50);
    // 24 random bytes, base64url — comfortably above the 32-byte HMAC ceiling
    // once the prefix is stripped is NOT the claim; the claim is simply that
    // the entropy is not accidentally truncated.
    for (const s of secrets) {
      expect(s.length).toBeGreaterThan("ccp_whsec_".length + 24);
    }
  });
});

describe("the wire version", () => {
  it("is 1 — bumping it is a breaking change for every partner", () => {
    // Pinned deliberately. `WEBHOOK_WIRE_VERSION` is stamped in the body as `v`
    // AND in X-CCP-Webhook-Version; the docblock says bump ONLY on a breaking
    // body-shape change, additive fields stay v1. A silent bump would make
    // every partner's version check fail at once, so it should cost a
    // deliberate test edit.
    expect(WEBHOOK_WIRE_VERSION).toBe(1);
  });
});
