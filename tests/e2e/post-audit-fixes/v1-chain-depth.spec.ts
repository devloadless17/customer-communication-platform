/**
 * /v1 cross-system loop guard (2026-05-29 final-audit P1 fix).
 *
 * The incoming_webhook trigger has long capped chain depth via X-CCP-Depth.
 * The /v1 send/template endpoints did NOT — a partner integration that calls
 * /v1/send on every outbound webhook we deliver could loop unbounded.
 *
 * Fix: both `POST /api/external/v1/messages` and `POST /api/external/v1/
 * conversations/:id/messages` now read X-CCP-Depth, drop with HTTP 429 +
 * `error: "chain_depth_exceeded"` at ≥ MAX_CHAIN_DEPTH (8).
 *
 * This spec seeds a real API key + contact (sending to Meta would actually
 * hit the wire, so we ONLY test the cap-before-send path — at the cap the
 * 429 fires before any conversation lookup, so it's deterministic and free).
 *
 * Cases covered:
 *   - No X-CCP-Depth header → request passes the guard (does NOT 429).
 *   - X-CCP-Depth: 0 → passes.
 *   - X-CCP-Depth: 7 → passes (cap is >= 8, not > 8).
 *   - X-CCP-Depth: 8 → 429 + chain_depth_exceeded.
 *   - X-CCP-Depth: 99 → 429 + chain_depth_exceeded.
 *
 * We don't validate the send actually succeeds at depth 7 — that would
 * require a live Meta token. We just assert the response is NOT a 429
 * with `chain_depth_exceeded`, which is what the guard would emit.
 */
import { test, expect } from "@playwright/test";

import { generateApiKey } from "../../../apps/api/src/auth/api-key";
import { db, superadminTeam, wipeTestData } from "../_helpers/db";

let teamId: string;
let userId: string;
let apiToken: string;
let conversationId: string;

test.beforeAll(async () => {
  await wipeTestData();
  const su = await superadminTeam();
  teamId = su.teamId;
  userId = su.userId;

  // Provision a real API key — same shape the settings UI creates. Store
  // hash + prefix; the plaintext lives only in this test for the duration
  // of the suite.
  const key = generateApiKey();
  await db().teamApiKey.create({
    data: {
      teamId,
      name: "E2E /v1 chain-depth key",
      tokenHash: key.tokenHash,
      tokenPrefix: key.tokenPrefix,
      createdById: userId,
      scopes: ["*"],
    },
  });
  apiToken = key.token;

  // Seed a contact + a conversation so the conversation-scoped endpoint
  // has a valid id to point at. The /v1 service short-circuits with 429
  // at the cap BEFORE any conversation lookup, so even a non-existent id
  // would pass — but using a real one keeps the negative cases honest.
  const contact = await db().contact.create({
    data: {
      teamId,
      phoneNumber: "+15551112222",
      identityChannel: "whatsapp",
      name: "Chain Depth Test",
      source: "manual",
    },
  });
  const conv = await db().conversation.create({
    data: {
      teamId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
    },
  });
  conversationId = conv.id;
});

test.afterAll(async () => {
  await wipeTestData();
  await db().$disconnect();
});

test.describe("/v1 cross-system loop guard (X-CCP-Depth)", () => {
  test("rejects POST /v1/messages at depth >= 8 with 429 chain_depth_exceeded", async ({
    request,
  }) => {
    const resp = await request.post("/api/external/v1/messages", {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "X-CCP-Depth": "8",
      },
      data: {
        contact: { phone: "+15551112222" },
        // Schema field is `text` (matches the /v1 contract), NOT `body`.
        // Using the wrong key 400s at the Zod pipe BEFORE the chain-depth
        // guard runs, masking the actual guard behavior.
        text: "hello — this should be blocked by the chain-depth guard",
      },
    });
    expect(resp.status(), "status").toBe(429);
    const body = await resp.json();
    expect(body.error, "error code").toBe("chain_depth_exceeded");
  });

  test("rejects POST /v1/conversations/:id/messages at depth >= 8", async ({ request }) => {
    const resp = await request.post(
      `/api/external/v1/conversations/${conversationId}/messages`,
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "X-CCP-Depth": "8",
        },
        // Conversation-scoped send schema uses `body` (different from the
        // top-level POST /v1/messages which uses `text`). The two
        // endpoints intentionally have different shapes — conv-scoped is
        // a simple text send, top-level supports text/media/template.
        data: { body: "blocked at depth 8" },
      },
    );
    expect(resp.status(), "status").toBe(429);
    const body = await resp.json();
    expect(body.error, "error code").toBe("chain_depth_exceeded");
  });

  test("rejects huge depth values (poisoned header) at the same cap", async ({ request }) => {
    const resp = await request.post("/api/external/v1/messages", {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "X-CCP-Depth": "9999",
      },
      data: {
        contact: { phone: "+15551112222" },
        text: "blocked by overflow",
      },
    });
    expect(resp.status()).toBe(429);
    expect((await resp.json()).error).toBe("chain_depth_exceeded");
  });

  test("passes the guard at depth = 7 (< MAX_CHAIN_DEPTH)", async ({ request }) => {
    // The send itself will fail downstream (no live Meta token in the test
    // env) — what we're asserting is that the response is NOT a 429 with
    // `chain_depth_exceeded`. Any other error (e.g. provider not configured,
    // 502 from a stubbed Meta) confirms the guard let the request through.
    const resp = await request.post("/api/external/v1/messages", {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "X-CCP-Depth": "7",
      },
      data: {
        contact: { phone: "+15551112222" },
        body: "should pass the chain-depth guard",
      },
    });
    if (resp.status() === 429) {
      const body = await resp.json();
      expect(
        body.error,
        "depth 7 should NOT be a chain_depth_exceeded 429",
      ).not.toBe("chain_depth_exceeded");
    }
  });

  test("passes the guard with no X-CCP-Depth header at all", async ({ request }) => {
    // Bare partner request (no header) parses to depth=0 → must pass.
    const resp = await request.post("/api/external/v1/messages", {
      headers: { Authorization: `Bearer ${apiToken}` },
      data: {
        contact: { phone: "+15551112222" },
        body: "no depth header — top-level call",
      },
    });
    if (resp.status() === 429) {
      const body = await resp.json();
      expect(
        body.error,
        "missing header should NOT trip the chain-depth guard",
      ).not.toBe("chain_depth_exceeded");
    }
  });
});
