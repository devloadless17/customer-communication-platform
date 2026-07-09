/**
 * Meta outbound sends — Messenger + Instagram, through the REAL send pipeline
 * (/v1 send → provider.sendText → Graph POST) against the mock Graph server, so
 * we can assert the exact wire shape Meta would receive.
 *
 * Verifies the things a channel MUST get right on the wire: recipient id,
 * messaging_type RESPONSE inside the 24h window vs the HUMAN_AGENT tag past it,
 * the Instagram-sends-via-Page-host rule, quoted-reply fragment, and send
 * idempotency (a repeated Idempotency-Key never double-posts to Meta).
 */

import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";
import {
  seedMetaTestTeam,
  wipeMetaTestTeam,
  seedSocialConversation,
  v1Send,
  resetMock,
  mockSends,
  META_TEST_TEAM_ID,
  MSGR_PAGE_ID,
  IG_PAGE_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

let apiToken: string;

test.beforeAll(async () => {
  ({ apiToken } = await seedMetaTestTeam());
});
test.afterAll(async () => {
  await wipeMetaTestTeam();
});
test.beforeEach(async () => {
  await resetMock();
});

const DAY = 24 * 60 * 60 * 1000;

test("Messenger send inside the window → RESPONSE to the PSID via the Page host", async () => {
  const psid = "6100000000001";
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "messenger",
    externalContactId: psid,
    name: "Msgr Customer",
    lastInboundAt: new Date(), // fresh → RESPONSE
  });

  const res = await v1Send(apiToken, conversationId, { body: "hi there" }, "idem-msgr-1");
  expect(res.status, JSON.stringify(res.json)).toBe(201);

  const sends = await mockSends();
  expect(sends).toHaveLength(1);
  const s = sends[0]!;
  expect(s.path).toBe(`/v25.0/${MSGR_PAGE_ID}/messages`);
  expect(s.body.recipient.id).toBe(psid);
  expect(s.body.messaging_type).toBe("RESPONSE");
  expect(s.body.tag).toBeUndefined();
  expect(s.body.message.text).toBe("hi there");
  // Never a WhatsApp-shaped body on a social send.
  expect(s.body.messaging_product).toBeUndefined();

  const msg = await db().message.findFirst({
    where: { teamId: META_TEST_TEAM_ID, conversationId, direction: "out" },
    select: { status: true, externalId: true, channel: true },
  });
  expect(msg?.channel).toBe("messenger");
  expect(msg?.externalId).toMatch(/^mid\.MOCK\./);
});

test("Messenger send past 24h → HUMAN_AGENT tag (still inside the 7d support window)", async () => {
  const psid = "6100000000002";
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "messenger",
    externalContactId: psid,
    name: "Old Thread",
    lastInboundAt: new Date(Date.now() - 2 * DAY), // >24h, <7d
  });

  const res = await v1Send(apiToken, conversationId, { body: "following up" }, "idem-msgr-2");
  expect(res.status, JSON.stringify(res.json)).toBe(201);

  const s = (await mockSends())[0]!;
  expect(s.body.messaging_type).toBe("MESSAGE_TAG");
  expect(s.body.tag).toBe("HUMAN_AGENT");
});

test("Instagram send targets the linked Page host with the IGSID recipient", async () => {
  const igsid = "17840000000101";
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "instagram",
    externalContactId: igsid,
    name: "IG Customer",
    lastInboundAt: new Date(),
  });

  const res = await v1Send(apiToken, conversationId, { body: "hey on IG" }, "idem-ig-1");
  expect(res.status, JSON.stringify(res.json)).toBe(201);

  const s = (await mockSends())[0]!;
  // Instagram-via-Facebook-Login sends through the PAGE, not the IG id.
  expect(s.path).toBe(`/v25.0/${IG_PAGE_ID}/messages`);
  expect(s.body.recipient.id).toBe(igsid);
  expect(s.body.messaging_type).toBe("RESPONSE");
});

test("quoted reply attaches a top-level reply_to.mid", async () => {
  const psid = "6100000000003";
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "messenger",
    externalContactId: psid,
    name: "Reply Thread",
    lastInboundAt: new Date(),
  });
  const original = await db().message.create({
    data: {
      teamId: META_TEST_TEAM_ID,
      conversationId,
      channel: "messenger",
      externalId: "mid.orig.reply",
      direction: "in",
      status: "delivered",
      body: "customer question",
      timestamp: new Date(),
    },
    select: { id: true },
  });

  const res = await v1Send(
    apiToken,
    conversationId,
    { body: "answering that", replyToMessageId: original.id },
    "idem-reply-1",
  );
  expect(res.status, JSON.stringify(res.json)).toBe(201);

  const s = (await mockSends())[0]!;
  expect(s.body.reply_to).toEqual({ mid: "mid.orig.reply" });
});

test("a repeated Idempotency-Key never double-posts to Meta", async () => {
  const psid = "6100000000004";
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "messenger",
    externalContactId: psid,
    name: "Idem Thread",
    lastInboundAt: new Date(),
  });

  const first = await v1Send(apiToken, conversationId, { body: "only once" }, "idem-dupe-key");
  const second = await v1Send(apiToken, conversationId, { body: "only once" }, "idem-dupe-key");
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);

  // Exactly one Meta send, and exactly one outbound message row.
  expect(await mockSends()).toHaveLength(1);
  const count = await db().message.count({
    where: { teamId: META_TEST_TEAM_ID, conversationId, direction: "out" },
  });
  expect(count).toBe(1);
});

test("send past the 7d effective window is refused with no Meta call", async () => {
  const psid = "6100000000005";
  const { conversationId } = await seedSocialConversation({
    teamId: META_TEST_TEAM_ID,
    channel: "messenger",
    externalContactId: psid,
    name: "Stale Thread",
    lastInboundAt: new Date(Date.now() - 8 * DAY), // outside 7d
  });

  const res = await v1Send(apiToken, conversationId, { body: "too late" }, "idem-stale-1");
  expect(res.status).toBe(422);
  expect(res.json.error).toBe("outside_24h_window");
  expect(await mockSends()).toHaveLength(0);
});
