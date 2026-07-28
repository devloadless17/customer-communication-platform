/**
 * INGEST + SEND routing across two accounts on one channel.
 *
 * The two things the product promises most directly:
 *   - a message arrives ON the account the customer messaged, not the default;
 *   - a reply goes OUT the account the thread belongs to, so the customer never
 *     hears from a number they never contacted (which has no 24h window and
 *     shows an unknown sender).
 *
 * Both were regressions waiting to happen: inbound HMAC used to be resolved
 * from the DEFAULT account only, so a second number's webhooks failed
 * signature verification and were dropped as forged — silently, and
 * permanently once Meta stopped retrying.
 */
import { expect, test } from "@playwright/test";

import { db } from "../_helpers/db";
import { META_API_BASE, postMetaWebhook, resetMock, sendAccountIds, v1Send } from "../_helpers/meta";
import {
  MA,
  MA_CONN,
  MA_TEAM_ID,
  clearMultiAccountData,
  seedBoundConversation,
  seedMultiAccountTeam,
  waInboundTo,
} from "../_helpers/multi-account";

test.describe.configure({ mode: "serial" });

let apiToken = "";

test.beforeAll(async () => {
  ({ apiToken } = await seedMultiAccountTeam());
});

test.beforeEach(async () => {
  await resetMock();
  await clearMultiAccountData();
});

test("inbound on the NON-default number lands on that number, not the default", async () => {
  const from = "9611000001";
  const res = await postMetaWebhook(
    MA_TEAM_ID,
    waInboundTo({
      phoneNumberId: MA.whatsapp.b.account,
      wabaId: MA.whatsapp.b.waba,
      from,
      mid: "wamid.ma.b.1",
      text: "hello support",
    }),
  );
  expect(res.status, res.text).toBe(200);

  const conv = await db().conversation.findFirstOrThrow({
    where: { workspaceId: MA_TEAM_ID, contact: { phoneNumber: from } },
    select: { channelConnectionId: true },
  });
  // POSITIVE — attributed to the number actually messaged.
  expect(conv.channelConnectionId).toBe(MA_CONN.whatsappB);
  // NEGATIVE — never silently folded onto the default.
  expect(conv.channelConnectionId).not.toBe(MA_CONN.whatsappA);
});

test("the inbound MESSAGE records its own account too", async () => {
  const from = "9611000002";
  await postMetaWebhook(
    MA_TEAM_ID,
    waInboundTo({
      phoneNumberId: MA.whatsapp.b.account,
      wabaId: MA.whatsapp.b.waba,
      from,
      mid: "wamid.ma.b.2",
      text: "hi",
    }),
  );
  const msg = await db().message.findFirstOrThrow({
    where: { workspaceId: MA_TEAM_ID, externalId: "wamid.ma.b.2" },
    select: { channelConnectionId: true },
  });
  expect(msg.channelConnectionId).toBe(MA_CONN.whatsappB);
});

test("a reply goes out the THREAD's number, not the workspace default", async () => {
  const { conversationId } = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappB,
    name: "MA Support Customer",
    phoneNumber: "9611000003",
  });

  const res = await v1Send(apiToken, conversationId, { body: "replying" }, "ma-send-b-1");
  expect(res.status, JSON.stringify(res.json)).toBe(201);

  const accounts = await sendAccountIds();
  expect(accounts).toHaveLength(1);
  // POSITIVE / NEGATIVE in one assertion: the wire itself names the number.
  expect(accounts[0]).toBe(MA.whatsapp.b.account);
  expect(accounts[0]).not.toBe(MA.whatsapp.a.account);
});

test("two live threads on two numbers reply from their OWN numbers", async () => {
  const a = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA,
    name: "MA Sales Customer",
    phoneNumber: "9611000004",
  });
  const b = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappB,
    name: "MA Support Customer 2",
    phoneNumber: "9611000005",
  });

  expect((await v1Send(apiToken, a.conversationId, { body: "from sales" }, "ma-a-1")).status).toBe(201);
  expect((await v1Send(apiToken, b.conversationId, { body: "from support" }, "ma-b-1")).status).toBe(201);

  // Order is deterministic — the two sends are awaited in sequence.
  expect(await sendAccountIds()).toEqual([MA.whatsapp.a.account, MA.whatsapp.b.account]);
});

test("Messenger: inbound on the second Page attributes to that Page", async () => {
  const psid = "6200000000002";
  const res = await postMetaWebhook(MA_TEAM_ID, {
    object: "page",
    entry: [
      {
        // `entry[].id` IS the account for social — the Page that received it.
        id: MA.messenger.b.account,
        time: Date.now(),
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: MA.messenger.b.account },
            timestamp: Date.now(),
            message: { mid: "m_ma_b_1", text: "hi second page" },
          },
        ],
      },
    ],
  });
  expect(res.status, res.text).toBe(200);

  const conv = await db().conversation.findFirstOrThrow({
    where: { workspaceId: MA_TEAM_ID, contact: { externalContactId: psid } },
    select: { channelConnectionId: true },
  });
  expect(conv.channelConnectionId).toBe(MA_CONN.messengerB);
  expect(conv.channelConnectionId).not.toBe(MA_CONN.messengerA);
});

test("Instagram: inbound on the second account attributes to that account", async () => {
  const igsid = "7200000000002";
  const res = await postMetaWebhook(MA_TEAM_ID, {
    object: "instagram",
    entry: [
      {
        id: MA.instagram.b.account,
        time: Date.now(),
        messaging: [
          {
            sender: { id: igsid },
            recipient: { id: MA.instagram.b.account },
            timestamp: Date.now(),
            message: { mid: "ig_ma_b_1", text: "hi second ig" },
          },
        ],
      },
    ],
  });
  expect(res.status, res.text).toBe(200);

  const conv = await db().conversation.findFirstOrThrow({
    where: { workspaceId: MA_TEAM_ID, contact: { externalContactId: igsid } },
    select: { channelConnectionId: true },
  });
  expect(conv.channelConnectionId).toBe(MA_CONN.instagramB);
});

test("an UNBOUND thread is refused rather than replied to from a guess", async () => {
  // `onDelete: SetNull` on a disconnected account leaves live threads like
  // this. Replying from a sibling would reach the customer from a number they
  // never messaged — no service window, unknown sender. Refusing is correct.
  const { conversationId } = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA,
    name: "MA Orphan",
    phoneNumber: "9611000006",
  });
  await db().conversation.update({
    where: { id: conversationId },
    data: { channelConnectionId: null },
  });

  const res = await v1Send(apiToken, conversationId, { body: "should refuse" }, "ma-orphan-1");
  expect(res.status).toBe(409);
  // And nothing reached Meta.
  expect(await sendAccountIds()).toHaveLength(0);
});

test("the account directory reports BOTH accounts per channel", async () => {
  const res = await fetch(`${META_API_BASE}/api/external/v1/channel-accounts`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    accounts?: Array<{ id: string; channel: string; name: string; isDefault: boolean }>;
  };
  const accounts = body.accounts ?? [];
  // The directory exposes the CONNECTION row id (what every account-scoped
  // filter is keyed by), not the provider's id.
  const ids = accounts.map((a) => a.id);
  for (const expected of Object.values(MA_CONN)) {
    expect(ids).toContain(expected);
  }

  // Exactly one default per channel — two would make "which number does a
  // broadcast send from" whatever Postgres returned first.
  for (const channel of ["whatsapp", "messenger", "instagram"]) {
    const onChannel = accounts.filter((a) => a.channel === channel);
    expect(onChannel, channel).toHaveLength(2);
    expect(onChannel.filter((a) => a.isDefault), `${channel} defaults`).toHaveLength(1);
  }

  // Labels are distinct, so an agent can actually tell the two apart.
  expect(new Set(accounts.map((a) => a.name)).size).toBe(accounts.length);
});
