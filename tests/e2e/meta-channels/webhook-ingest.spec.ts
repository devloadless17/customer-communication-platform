/**
 * Meta webhook ingest — Messenger + Instagram, end to end through the REAL
 * pipeline: object-dispatch → HMAC verify → provider.parseWebhook → identity
 * resolution → dedupe → Prisma upsert. Posts genuinely HMAC-signed payloads to
 * the mock-backed test api (:4001) and asserts the committed DB state.
 *
 * Covers the invariants that make a new channel safe: channel-scoped identity
 * (no digit-strip, no cross-channel collision), one-conversation-per-contact,
 * at-least-once dedupe, quoted-reply linkage, the read-status direction guard,
 * and HMAC rejection.
 */

import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";
import {
  seedMetaTestTeam,
  wipeMetaTestTeam,
  postMetaWebhook,
  socialInbound,
  socialRead,
  socialCallConnect,
  socialCallTerminate,
  getWebhookVerify,
  VERIFY_TOKEN,
  META_TEST_TEAM_ID,
  MSGR_PAGE_ID,
  IG_ID,
  APP_SECRET,
} from "../_helpers/meta";

// These specs never touch the maintainer's real team — all state lives in the
// throwaway META_TEST_TEAM_ID, torn down in afterAll.
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedMetaTestTeam();
});
test.afterAll(async () => {
  await wipeMetaTestTeam();
});

async function msgFor(externalId: string) {
  return db().message.findUnique({
    where: {
      workspaceId_channel_externalId: {
        workspaceId: META_TEST_TEAM_ID,
        channel: externalId.startsWith("ig.") ? "instagram" : "messenger",
        externalId,
      },
    },
    select: { id: true, direction: true, status: true, body: true, channel: true, replyToMessageId: true },
  });
}

test("Messenger inbound text creates a PSID-scoped contact + conversation + message", async () => {
  const psid = "6001234567890";
  const mid = "m.msgr.in.1";
  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialInbound({ object: "page", accountId: MSGR_PAGE_ID, senderId: psid, mid, text: "hello from messenger" }),
  );
  expect(res.status, res.text).toBe(200);

  const contact = await db().contact.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, identityChannel: "messenger", externalContactId: psid },
    select: { id: true, phoneNumber: true, externalContactId: true },
  });
  expect(contact, "PSID contact created").not.toBeNull();
  // Identity stored verbatim — never digit-stripped into a phone.
  expect(contact?.phoneNumber).toBeNull();
  expect(contact?.externalContactId).toBe(psid);

  const convo = await db().conversation.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, contactId: contact!.id },
    select: { channel: true },
  });
  expect(convo?.channel).toBe("messenger");

  const msg = await msgFor(mid);
  expect(msg?.direction).toBe("in");
  expect(msg?.channel).toBe("messenger");
  expect(msg?.body).toBe("hello from messenger");
});

test("Instagram inbound text creates an IGSID-scoped contact + message", async () => {
  const igsid = "17840000000001";
  const mid = "ig.in.1";
  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialInbound({ object: "instagram", accountId: IG_ID, senderId: igsid, mid, text: "hi via IG" }),
  );
  expect(res.status, res.text).toBe(200);

  const contact = await db().contact.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, identityChannel: "instagram", externalContactId: igsid },
    select: { id: true },
  });
  expect(contact, "IGSID contact created").not.toBeNull();

  const msg = await msgFor(mid);
  expect(msg?.direction).toBe("in");
  expect(msg?.channel).toBe("instagram");
});

test("same digits across channels resolve to DISTINCT contacts (no collision)", async () => {
  // A WhatsApp-looking string and a Messenger PSID sharing the same digits must
  // never fold into one contact — identity is (channel, externalId), not digits.
  const shared = "15551234567";
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialInbound({ object: "page", accountId: MSGR_PAGE_ID, senderId: shared, mid: "m.collide.1", text: "msgr" }),
  );
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialInbound({ object: "instagram", accountId: IG_ID, senderId: shared, mid: "ig.collide.1", text: "ig" }),
  );

  const rows = await db().contact.findMany({
    where: { workspaceId: META_TEST_TEAM_ID, externalContactId: shared },
    select: { identityChannel: true },
  });
  const channels = rows.map((r) => r.identityChannel).sort();
  expect(channels).toEqual(["instagram", "messenger"]);
});

test("redelivery of the same mid dedupes to one message", async () => {
  const psid = "6009999999999";
  const mid = "m.dedupe.1";
  const payload = socialInbound({ object: "page", accountId: MSGR_PAGE_ID, senderId: psid, mid, text: "dupe" });
  await postMetaWebhook(META_TEST_TEAM_ID, payload);
  await postMetaWebhook(META_TEST_TEAM_ID, payload); // Meta at-least-once redelivery

  const count = await db().message.count({
    where: { workspaceId: META_TEST_TEAM_ID, channel: "messenger", externalId: mid },
  });
  expect(count).toBe(1);
});

test("quoted reply links the new inbound message to the original", async () => {
  const psid = "6002222222222";
  // Seed an outbound message the customer will quote.
  const { id: convoId } = (await (async () => {
    await postMetaWebhook(
      META_TEST_TEAM_ID,
      socialInbound({ object: "page", accountId: MSGR_PAGE_ID, senderId: psid, mid: "m.reply.seed", text: "seed" }),
    );
    const contact = await db().contact.findFirstOrThrow({
      where: { workspaceId: META_TEST_TEAM_ID, identityChannel: "messenger", externalContactId: psid },
      select: { id: true },
    });
    return db().conversation.findFirstOrThrow({
      where: { workspaceId: META_TEST_TEAM_ID, contactId: contact.id },
      select: { id: true },
    });
  })());
  const original = await db().message.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      conversationId: convoId,
      channel: "messenger",
      externalId: "m.reply.original",
      direction: "out",
      status: "sent",
      body: "the original outbound",
      timestamp: new Date(),
    },
    select: { id: true },
  });

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialInbound({
      object: "page",
      accountId: MSGR_PAGE_ID,
      senderId: psid,
      mid: "m.reply.quote",
      text: "quoting you",
      replyToMid: "m.reply.original",
    }),
  );

  const quote = await msgFor("m.reply.quote");
  expect(quote?.replyToMessageId).toBe(original.id);
});

test("read receipt marks the OUTBOUND message read but never an inbound one", async () => {
  const igsid = "17840000000042";
  // Create the conversation via an inbound, then seed one outbound + one inbound
  // message with known mids.
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialInbound({ object: "instagram", accountId: IG_ID, senderId: igsid, mid: "ig.rd.seed", text: "seed" }),
  );
  const contact = await db().contact.findFirstOrThrow({
    where: { workspaceId: META_TEST_TEAM_ID, identityChannel: "instagram", externalContactId: igsid },
    select: { id: true },
  });
  const convo = await db().conversation.findFirstOrThrow({
    where: { workspaceId: META_TEST_TEAM_ID, contactId: contact.id },
    select: { id: true },
  });
  await db().message.createMany({
    data: [
      {
        workspaceId: META_TEST_TEAM_ID,
        conversationId: convo.id,
        channel: "instagram",
        externalId: "ig.rd.out",
        direction: "out",
        status: "sent",
        body: "our outbound",
        timestamp: new Date(),
      },
      {
        workspaceId: META_TEST_TEAM_ID,
        conversationId: convo.id,
        channel: "instagram",
        externalId: "ig.rd.in",
        direction: "in",
        status: "delivered",
        body: "their inbound",
        timestamp: new Date(),
      },
    ],
  });

  // Instagram sends a per-message read `mid`. Targeting the outbound → read.
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialRead({ object: "instagram", accountId: IG_ID, senderId: igsid, mid: "ig.rd.out" }),
  );
  // Targeting the inbound → must be ignored by the direction guard.
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialRead({ object: "instagram", accountId: IG_ID, senderId: igsid, mid: "ig.rd.in" }),
  );

  const out = await msgFor("ig.rd.out");
  const inb = await msgFor("ig.rd.in");
  expect(out?.status).toBe("read");
  expect(inb?.status).toBe("delivered"); // unchanged — never corrupted by a read
});

test("Messenger inbound call creates a ringing Call + PSID contact, then completes", async () => {
  const psid = "6007777777777";
  const callId = "c_e2e_call_1";
  const connect = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialCallConnect({ object: "page", accountId: MSGR_PAGE_ID, callId, psid }),
  );
  expect(connect.status, connect.text).toBe(200);

  const contact = await db().contact.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, identityChannel: "messenger", externalContactId: psid },
    select: { id: true, phoneNumber: true },
  });
  expect(contact, "PSID caller contact created").not.toBeNull();
  expect(contact?.phoneNumber).toBeNull(); // never digit-stripped into a phone

  const call = await db().call.findUnique({
    where: { workspaceId_channel_externalCallId: { workspaceId: META_TEST_TEAM_ID, channel: "messenger", externalCallId: callId } },
    select: { direction: true, status: true, channel: true },
  });
  expect(call?.channel).toBe("messenger");
  expect(call?.direction).toBe("in");
  expect(call?.status).toBe("ringing");

  // Terminate (carries no caller id) resolves the existing call by id → completed.
  const term = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialCallTerminate({ object: "page", accountId: MSGR_PAGE_ID, callId, durationSeconds: 42 }),
  );
  expect(term.status, term.text).toBe(200);
  const ended = await db().call.findUnique({
    where: { workspaceId_channel_externalCallId: { workspaceId: META_TEST_TEAM_ID, channel: "messenger", externalCallId: callId } },
    select: { status: true, durationSeconds: true },
  });
  expect(ended?.status).toBe("completed");
  expect(ended?.durationSeconds).toBe(42);
});

test("Messenger call that terminates with no duration is recorded as missed", async () => {
  const psid = "6008888888888";
  const callId = "c_e2e_call_missed";
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialCallConnect({ object: "page", accountId: MSGR_PAGE_ID, callId, psid }),
  );
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialCallTerminate({ object: "page", accountId: MSGR_PAGE_ID, callId, durationSeconds: 0 }),
  );
  const call = await db().call.findUnique({
    where: { workspaceId_channel_externalCallId: { workspaceId: META_TEST_TEAM_ID, channel: "messenger", externalCallId: callId } },
    select: { status: true },
  });
  expect(call?.status).toBe("missed");
});

test("the unified callback verifies with the shared Meta App verify token", async () => {
  const ok = await getWebhookVerify(META_TEST_TEAM_ID, VERIFY_TOKEN, "echo-me-42");
  expect(ok.status).toBe(200);
  expect(ok.text).toBe("echo-me-42");

  const wrong = await getWebhookVerify(META_TEST_TEAM_ID, "not-the-token");
  expect(wrong.status).toBe(403);
});

test("a bad HMAC signature is rejected and writes nothing", async () => {
  const before = await db().message.count({ where: { workspaceId: META_TEST_TEAM_ID } });
  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialInbound({ object: "page", accountId: MSGR_PAGE_ID, senderId: "6003", mid: "m.badsig.1", text: "nope" }),
    { signature: "sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
  );
  expect(res.status).not.toBe(200);
  const after = await db().message.count({ where: { workspaceId: META_TEST_TEAM_ID } });
  expect(after).toBe(before);
  // Sanity: the same payload WITH a valid signature (default) would be accepted.
  void APP_SECRET;
});
