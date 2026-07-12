/**
 * `POST /v1/conversations/:id/interactive` — the external twin of the composer's
 * interactive send, closing the §12 UI↔/v1 parity gap.
 *
 *   - Messenger buttons + `contactShare` chips reach Meta as quick replies
 *   - Instagram list options reach Meta
 *   - WhatsApp refuses consent chips (422 contact_share_not_supported) — it has
 *     no such chip and must not silently drop them
 *   - a repeated Idempotency-Key replays instead of re-posting to Meta
 *   - duplicate option titles are rejected before we ever call Graph
 */

import { test, expect } from "@playwright/test";

import {
  seedMetaTestTeam,
  seedSocialConversation,
  resetMock,
  mockSends,
  v1SendInteractive,
  failNextMetaSend,
  META_TEST_TEAM_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

let apiToken: string;

test.beforeAll(async () => {
  ({ apiToken } = await seedMetaTestTeam());
});

test.beforeEach(async () => {
  await resetMock();
});

const uniq = () => Math.random().toString(36).slice(2, 10);

test("Messenger interactive send with consent chips posts quick replies to Meta", async () => {
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "messenger",
    externalContactId: `psid_int_${uniq()}`,
    name: "Interactive Customer",
    lastInboundAt: new Date(),
  });

  const res = await v1SendInteractive(
    apiToken,
    conversationId,
    {
      body: "How would you like your order?",
      kind: "buttons",
      options: [
        { id: "pickup", title: "Pick up" },
        { id: "deliver", title: "Deliver" },
      ],
      contactShare: ["phone"],
    },
    `idem-int-${uniq()}`,
  );
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  expect(res.json.ok).toBe(true);
  expect(typeof res.json.messageId).toBe("string");

  const sends = await mockSends();
  expect(sends).toHaveLength(1);
  const body = sends[0]!.body as Record<string, any>;
  // Quick replies carry our option ids in `payload`, plus the phone consent chip.
  const qrs = body.message.quick_replies as Array<Record<string, unknown>>;
  expect(qrs.map((q) => q.payload)).toEqual(
    expect.arrayContaining(["pickup", "deliver"]),
  );
  expect(qrs.some((q) => q.content_type === "user_phone_number")).toBe(true);
});

test("Instagram list options reach Meta as quick replies", async () => {
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "instagram",
    externalContactId: `igsid_int_${uniq()}`,
    name: "IG Interactive",
    lastInboundAt: new Date(),
  });

  const res = await v1SendInteractive(
    apiToken,
    conversationId,
    {
      body: "Pick a size",
      kind: "list",
      options: [
        { id: "s", title: "Small" },
        { id: "m", title: "Medium" },
        { id: "l", title: "Large" },
      ],
    },
    `idem-ig-int-${uniq()}`,
  );
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  expect(await mockSends()).toHaveLength(1);
});

test("WhatsApp refuses consent chips instead of silently dropping them", async () => {
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "whatsapp",
    phoneNumber: `9613${Math.floor(1000000 + Math.random() * 8999999)}`,
    name: "WA Interactive",
    lastInboundAt: new Date(),
  });

  const res = await v1SendInteractive(
    apiToken,
    conversationId,
    {
      body: "Share your phone?",
      kind: "buttons",
      options: [{ id: "yes", title: "Yes" }],
      contactShare: ["phone"],
    },
    `idem-wa-int-${uniq()}`,
  );
  expect(res.status).toBe(422);
  expect(res.json.error).toBe("contact_share_not_supported");
  // Provably-not-sent → nothing reached Meta.
  expect(await mockSends()).toHaveLength(0);
});

test("a repeated Idempotency-Key replays without a second Meta post", async () => {
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "messenger",
    externalContactId: `psid_idem_${uniq()}`,
    name: "Idem Customer",
    lastInboundAt: new Date(),
  });

  const key = `idem-replay-${uniq()}`;
  const payload = {
    body: "Confirm?",
    kind: "buttons" as const,
    options: [{ id: "ok", title: "OK" }],
  };

  const first = await v1SendInteractive(apiToken, conversationId, payload, key);
  expect(first.status, JSON.stringify(first.json)).toBe(201);
  const second = await v1SendInteractive(apiToken, conversationId, payload, key);
  expect(second.status).toBe(201);

  // Same message id returned, and Meta saw exactly ONE send.
  expect(second.json.messageId).toBe(first.json.messageId);
  expect(await mockSends()).toHaveLength(1);
});

test("duplicate option titles are rejected before Meta is called", async () => {
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "messenger",
    externalContactId: `psid_dup_${uniq()}`,
    name: "Dup Titles",
    lastInboundAt: new Date(),
  });

  const res = await v1SendInteractive(
    apiToken,
    conversationId,
    {
      body: "Choose",
      kind: "buttons",
      options: [
        { id: "a", title: "Same" },
        { id: "b", title: "Same" },
      ],
    },
    `idem-dup-${uniq()}`,
  );
  expect(res.status).toBe(400);
  expect(await mockSends()).toHaveLength(0);
});

/**
 * OUTBOUND-1 — the invariant that keeps a partner's retry from billing twice.
 *
 * An AMBIGUOUS failure (Meta 5xx / timeout: the message may already be
 * delivered) must KEEP the idempotency claim, so a same-key retry is refused
 * with 409 rather than re-sending. A PROVABLE non-send (validation, Meta 4xx)
 * must RELEASE the claim so a corrected retry can proceed.
 *
 * SCOPE — read before trusting these two tests:
 * They cover the MetaSendError arms of that decision, not the whole of it.
 * There is a THIRD, nastier ambiguous case they do NOT reach: because
 * `sendInteractiveInternal` calls Meta first and commits second, a conversation
 * deleted between those two steps makes `commitOutboundSend`'s `onMissing` throw
 * a `SendTextValidationError` carrying the SAME `conversation_not_found` code the
 * PRE-send guard uses — after Meta has already accepted and billed. Releasing the
 * claim there would let a same-key retry send a second billed message. That is
 * discriminated by `err.message === "conversation_disappeared_mid_send"` in
 * external-v1-messaging.service.ts and answered with 502 `send_ambiguous`.
 *
 * Driving it end-to-end would need to delete the conversation inside the window
 * between the Meta POST and the commit transaction — not reachable without a
 * test-only hook in production code, which isn't worth it. It is held by code
 * review and by the comments at both sites. Don't assume these tests cover it.
 */
test("an ambiguous Meta 5xx RETAINS the idempotency claim — a same-key retry is refused, not re-sent", async () => {
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "messenger",
    externalContactId: `psid_amb_${uniq()}`,
    name: "Ambiguous Send",
    lastInboundAt: new Date(),
  });

  const key = `idem-ambiguous-${uniq()}`;
  const payload = {
    body: "Did it land?",
    kind: "buttons" as const,
    options: [{ id: "yes", title: "Yes" }],
  };

  // Arm more failures than the provider's internal transient-retry budget, so
  // the 5xx is TERMINAL rather than being retried into a success.
  await failNextMetaSend(500, 10);
  const first = await v1SendInteractive(apiToken, conversationId, payload, key);
  expect(first.status, JSON.stringify(first.json)).toBeGreaterThanOrEqual(400);

  // However many attempts the provider made, record the count — the point is
  // that the RETRY adds none.
  const attemptsAfterFirst = (await mockSends()).length;
  expect(attemptsAfterFirst).toBeGreaterThan(0);

  // Meta is healthy again, but the pending claim must refuse the retry: the send
  // was AMBIGUOUS (5xx — it may already be delivered and billed), so re-sending
  // is the one thing we must never do.
  const retry = await v1SendInteractive(apiToken, conversationId, payload, key);
  expect(retry.status, JSON.stringify(retry.json)).toBe(409);
  expect(await mockSends()).toHaveLength(attemptsAfterFirst);
});

test("a provable non-send (Meta 4xx) RELEASES the claim so a corrected retry can proceed", async () => {
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "messenger",
    externalContactId: `psid_4xx_${uniq()}`,
    name: "Rejected Send",
    lastInboundAt: new Date(),
  });

  const key = `idem-4xx-${uniq()}`;
  const payload = {
    body: "Rejected first",
    kind: "buttons" as const,
    options: [{ id: "ok", title: "OK" }],
  };

  // A 4xx is NOT transient — the provider does not retry it.
  await failNextMetaSend(400, 1);
  const first = await v1SendInteractive(apiToken, conversationId, payload, key);
  expect(first.status).toBeGreaterThanOrEqual(400);
  expect(await mockSends()).toHaveLength(1);

  // Meta refused → nothing was sent → the same key may be reused and DOES send.
  const retry = await v1SendInteractive(apiToken, conversationId, payload, key);
  expect(retry.status, JSON.stringify(retry.json)).toBe(201);
  expect(await mockSends()).toHaveLength(2);
});
