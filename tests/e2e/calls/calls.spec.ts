/**
 * WhatsApp Calling e2e. Targets the load-bearing API surface around the
 * outbound pre-flight gauntlet, the inbound answer CAS race, and the
 * terminal-state idempotency contracts. Lives next to the workflows
 * suite so the same prod:local stack at :8080 covers both.
 *
 * Specifically NOT in scope:
 *   - The actual Meta `placeCall` / `preAccept` / `accept` / `end` HTTP
 *     calls — the test team has no Meta credentials and we explicitly
 *     skip the happy-path "real Meta send" flows. The pre-flight gauntlet
 *     and CAS layer fail BEFORE Meta is hit, so those are the testable
 *     surface here.
 *
 * Suites:
 *   A. Outbound pre-flight: bic_blocked_region    — US contact → blocked
 *   B. Outbound pre-flight: permission_revoked     — future revocation → blocked
 *   C. Outbound pre-flight: daily_cap_reached      — 5 connected calls/24h → blocked
 *   D. answerCall CAS race                          — exactly one winner
 *   E. endCall idempotency                          — terminal row → 200 no-op
 *   F. Call history listing                         — descending ringingAt
 */
import { test, expect } from "@playwright/test";
import { db, appAdmin, wipeTestData, pollUntil } from "../_helpers/db";

// ─── Fixture: team + base contact reused as the parent for siloed
// per-spec contacts. Each spec creates its own Contact + Conversation so
// the cap counts and permission rows can't bleed between cases.
let teamId: string;
let userId: string;

test.beforeAll(async () => {
  await wipeTestData();
  // The browsing/request identity is the e2e app-admin (the super-admin can't
  // use the customer app). answerCall is attributed to THIS user.
  const su = await appAdmin();
  teamId = su.teamId;
  userId = su.userId;
});

test.afterAll(async () => {
  await wipeTestData();
  await db().$disconnect();
});

// Small helper — each spec needs its own contact+conversation so the
// pre-flight gates evaluate the right state independently.
async function seedContactAndConversation(opts: {
  phoneNumber: string;
  countryCode?: string | null;
  callPermissionRevokedUntil?: Date | null;
  // lastInboundAt within 24h opens the 24h window so the permission /
  // permission-revoked branch is the gate under test.
  insideWindow?: boolean;
}): Promise<{ contactId: string; conversationId: string }> {
  const lastInboundAt = opts.insideWindow ? new Date() : null;
  const contact = await db().contact.create({
    data: {
      teamId,
      phoneNumber: opts.phoneNumber,
      identityChannel: "whatsapp",
      name: "Calls E2E",
      source: "manual",
      countryCode: opts.countryCode ?? null,
      callPermissionRevokedUntil: opts.callPermissionRevokedUntil ?? null,
      lastInboundAt,
    },
    select: { id: true },
  });
  const conv = await db().conversation.create({
    data: {
      teamId,
      contactId: contact.id,
      channel: "whatsapp",
      status: "open",
      lastMessageAt: new Date(),
      lastMessagePreview: "",
    },
    select: { id: true },
  });
  return { contactId: contact.id, conversationId: conv.id };
}

// A fake SDP — InitiateCallSchema requires a non-empty string ≤ 64KB.
// Whatever bytes we pass never reach Meta in the cases we hit; the
// pre-flight gauntlet fails first.
const FAKE_SDP_OFFER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
const FAKE_SDP_ANSWER = FAKE_SDP_OFFER;

// ═════════════════════════════════════════════════════════════════════════
// A. Outbound pre-flight — bic_blocked_region
// ═════════════════════════════════════════════════════════════════════════
test.describe("A. Outbound pre-flight — bic_blocked_region", () => {
  test("US-coded contact → { ok: false, reason: bic_blocked_region } and NO Call row", async ({ request }) => {
    // ARRANGE — contact with US country code (in BIC_BLOCKED_COUNTRY_CODES).
    const { conversationId } = await seedContactAndConversation({
      phoneNumber: "+15551110001",
      countryCode: "US",
      insideWindow: true,
    });

    // ACT
    const resp = await request.post(`/api/conversations/${conversationId}/call`, {
      data: { sdp: FAKE_SDP_OFFER },
    });

    // ASSERT — the route returns 200 with the structured failure (no 5xx
    // ever bubbles from the gauntlet, see calls.service.ts header).
    expect(resp.status(), `body=${await resp.text().catch(() => "")}`).toBe(200);
    const json = await resp.json();
    expect(json).toEqual({ ok: false, reason: "bic_blocked_region" });

    // Defense-in-depth: no Call row was inserted for this conversation.
    const callCount = await db().call.count({ where: { conversationId } });
    expect(callCount).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// B. Outbound pre-flight — permission_revoked
// ═════════════════════════════════════════════════════════════════════════
test.describe("B. Outbound pre-flight — permission_revoked", () => {
  test("contact with future callPermissionRevokedUntil → { ok: false, reason: permission_revoked }", async ({ request }) => {
    // ARRANGE — revocation 1h in the future. Country code is intentionally
    // an allowed region (FR) so the BIC gate doesn't short-circuit first.
    const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
    const { conversationId } = await seedContactAndConversation({
      phoneNumber: "+33611110002",
      countryCode: "FR",
      callPermissionRevokedUntil: oneHourFromNow,
      insideWindow: true,
    });

    // ACT
    const resp = await request.post(`/api/conversations/${conversationId}/call`, {
      data: { sdp: FAKE_SDP_OFFER },
    });

    // ASSERT
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    expect(json).toEqual({ ok: false, reason: "permission_revoked" });

    // No Call row created.
    const callCount = await db().call.count({ where: { conversationId } });
    expect(callCount).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// C. Outbound pre-flight — daily_cap_reached
// ═════════════════════════════════════════════════════════════════════════
test.describe("C. Outbound pre-flight — daily_cap_reached", () => {
  test("5 connected outbound Calls in last 24h → { ok: false, reason: daily_cap_reached }", async ({ request }) => {
    // ARRANGE — inside-24h-window contact in an allowed region.
    const { conversationId } = await seedContactAndConversation({
      phoneNumber: "+33611110003",
      countryCode: "FR",
      insideWindow: true,
    });

    // Seed 5 outbound, answered (= connected) Calls inside the 24h window.
    // The service counts ONLY calls with answeredAt non-null + ringingAt
    // within the last 24h, matching Meta's "5 connected per 24h" rule.
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      // Stagger ringingAt slightly so the timestamps differ and the
      // externalCallId stays unique (the row has a UNIQUE on
      // (teamId, channel, externalCallId)).
      const ringingAt = new Date(now.getTime() - (i + 1) * 1000);
      await db().call.create({
        data: {
          teamId,
          conversationId,
          externalCallId: `e2e-cap-${i}-${now.getTime()}`,
          channel: "whatsapp",
          direction: "out",
          status: "completed",
          ringingAt,
          answeredAt: new Date(ringingAt.getTime() + 100),
          endedAt: new Date(ringingAt.getTime() + 5_000),
          durationSeconds: 5,
          rawPayload: {},
        },
      });
    }

    // ACT
    const resp = await request.post(`/api/conversations/${conversationId}/call`, {
      data: { sdp: FAKE_SDP_OFFER },
    });

    // ASSERT
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    expect(json).toEqual({ ok: false, reason: "daily_cap_reached" });

    // The five seed rows are still there; no 6th was added.
    const callCount = await db().call.count({ where: { conversationId } });
    expect(callCount).toBe(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// D. answerCall CAS race
// ═════════════════════════════════════════════════════════════════════════
//
// Two parallel POSTs to /api/calls/:id/answer against a single ringing
// row. The CAS update (updateMany WHERE answeredByUserId IS NULL AND
// status='ringing') flips exactly one — the loser sees count=0 and the
// service throws 409 "already_answered". The winner may then 502 when
// the Meta provider can't be reached, but that's still a CAS win: we
// assert exactly one 409 across the pair (the other call won the race
// regardless of how its Meta hop resolved).
test.describe("D. answerCall — CAS race produces exactly one winner", () => {
  test("two parallel POSTs → exactly one 409 (the loser)", async ({ request }) => {
    // ARRANGE — a ringing inbound Call. answeredByUserId null, status ringing.
    const { conversationId } = await seedContactAndConversation({
      phoneNumber: "+33611110004",
      countryCode: "FR",
      insideWindow: true,
    });
    const call = await db().call.create({
      data: {
        teamId,
        conversationId,
        externalCallId: `e2e-cas-${Date.now()}`,
        channel: "whatsapp",
        direction: "in",
        status: "ringing",
        ringingAt: new Date(),
        rawPayload: {},
      },
      select: { id: true },
    });

    // ACT — fire two answer requests in parallel from the same session.
    // Same session is fine: CAS race is about the DB transaction order,
    // not the HTTP-level auth identity.
    const [respA, respB] = await Promise.all([
      request.post(`/api/calls/${call.id}/answer`, { data: { sdp: FAKE_SDP_ANSWER } }),
      request.post(`/api/calls/${call.id}/answer`, { data: { sdp: FAKE_SDP_ANSWER } }),
    ]);

    // ASSERT — exactly one returns 409 (already_answered). The other
    // request won the CAS; what it does next (200 happy-path OR 502 from
    // a Meta hop in the test env) is provider-dependent and not the
    // race-correctness assertion under test.
    const statuses = [respA.status(), respB.status()].sort();
    const conflicts = statuses.filter((s) => s === 409).length;
    expect(
      conflicts,
      `expected exactly one 409 across [${statuses.join(",")}]`,
    ).toBe(1);

    // Verify DB state converges: row is no longer in ringing (the winner
    // either flipped it to in_progress, or — if Meta rejected — rolled
    // back to failed).
    const final = await db().call.findUnique({
      where: { id: call.id },
      select: { status: true, answeredByUserId: true },
    });
    expect(final?.status).not.toBe("ringing");
    // answeredByUserId is set on CAS-win regardless of the later Meta
    // outcome (the rollback flips status to failed but leaves answeredBy
    // for the audit trail).
    expect(final?.answeredByUserId).toBe(userId);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E. endCall — idempotency on terminal rows
// ═════════════════════════════════════════════════════════════════════════
test.describe("E. endCall — terminal-row idempotency", () => {
  test("POST /end on an already-completed call → 200 + { ok: true, durationSeconds: null }", async ({ request }) => {
    // ARRANGE — completed Call row, durationSeconds 42 (already terminated
    // by some prior path).
    const { conversationId } = await seedContactAndConversation({
      phoneNumber: "+33611110005",
      countryCode: "FR",
      insideWindow: true,
    });
    const ringingAt = new Date(Date.now() - 60_000);
    const answeredAt = new Date(ringingAt.getTime() + 1_000);
    const endedAt = new Date(answeredAt.getTime() + 42_000);
    const call = await db().call.create({
      data: {
        teamId,
        conversationId,
        externalCallId: `e2e-end-idem-${Date.now()}`,
        channel: "whatsapp",
        direction: "out",
        status: "completed",
        ringingAt,
        answeredAt,
        endedAt,
        durationSeconds: 42,
        rawPayload: {},
      },
      select: { id: true },
    });

    // ACT
    const resp = await request.post(`/api/calls/${call.id}/end`, { data: {} });

    // ASSERT — 200 + structured success. The service short-circuits on
    // terminal rows and returns null durationSeconds (since the original
    // termination already computed + stored it; the idempotency path
    // doesn't re-compute, by design).
    expect(resp.status()).toBe(200);
    const json = await resp.json();
    expect(json).toEqual({ ok: true, durationSeconds: null });

    // DB state untouched.
    const after = await db().call.findUnique({
      where: { id: call.id },
      select: { status: true, durationSeconds: true, endedAt: true },
    });
    expect(after?.status).toBe("completed");
    expect(after?.durationSeconds).toBe(42);
    expect(after?.endedAt?.getTime()).toBe(endedAt.getTime());
  });
});

// ═════════════════════════════════════════════════════════════════════════
// F. Call history listing
// ═════════════════════════════════════════════════════════════════════════
test.describe("F. GET /api/conversations/:id/calls — listing", () => {
  test("3 seeded calls → 3 items returned in descending ringingAt order", async ({ request }) => {
    // ARRANGE — three calls staggered across the last few minutes. We
    // seed them out-of-order to make sure the ORDER BY is doing real
    // work (not just preserving insertion order).
    const { conversationId } = await seedContactAndConversation({
      phoneNumber: "+33611110006",
      countryCode: "FR",
      insideWindow: true,
    });
    const base = Date.now();
    // Insert middle, newest, oldest — verifies sort is by ringingAt, not id.
    const seeds = [
      { offsetMs: -120_000, label: "middle" },
      { offsetMs: -60_000, label: "newest" },
      { offsetMs: -180_000, label: "oldest" },
    ];
    for (const s of seeds) {
      await db().call.create({
        data: {
          teamId,
          conversationId,
          externalCallId: `e2e-list-${s.label}-${base}`,
          channel: "whatsapp",
          direction: "out",
          status: "completed",
          ringingAt: new Date(base + s.offsetMs),
          rawPayload: { label: s.label },
        },
      });
    }

    // Eventual-consistency safety: the rows are committed before we
    // query, but a tiny poll keeps the test resilient if the underlying
    // pool returns stale reads briefly under CI load.
    const list = await pollUntil(
      async () => {
        const resp = await request.get(`/api/conversations/${conversationId}/calls`);
        if (!resp.ok()) return null;
        const json = (await resp.json()) as {
          items: Array<{ id: string; ringingAt: string; externalCallId: string }>;
          cursor: string | null;
        };
        return json.items.length === 3 ? json : null;
      },
      { timeoutMs: 5_000, label: "GET /calls returns 3 items" },
    );

    // ASSERT — three items, ringingAt is monotone descending, the
    // externalCallId order matches newest → middle → oldest.
    expect(list.items).toHaveLength(3);
    for (let i = 1; i < list.items.length; i++) {
      expect(new Date(list.items[i - 1]!.ringingAt).getTime()).toBeGreaterThan(
        new Date(list.items[i]!.ringingAt).getTime(),
      );
    }
    expect(list.items[0]!.externalCallId).toContain("newest");
    expect(list.items[1]!.externalCallId).toContain("middle");
    expect(list.items[2]!.externalCallId).toContain("oldest");
    // Three items at default take=50 → no more pages.
    expect(list.cursor).toBeNull();
  });
});
