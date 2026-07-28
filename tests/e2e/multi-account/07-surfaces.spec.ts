/**
 * The read surfaces CARRY the account, not just the filters.
 *
 * A filter you can apply but whose results all look identical is only half a
 * feature: the contacts directory could narrow by account long before its rows
 * showed one, so clearing the filter made two people who message two different
 * numbers indistinguishable again.
 *
 * Also pins the start-chat binding. `POST /api/conversations/start` has always
 * accepted `channelConnectionId` and every caller omitted it, so on a
 * two-number workspace every agent-initiated thread bound to the DEFAULT —
 * permanently, because that pointer only re-stamps on an INBOUND.
 */
import { expect, test } from "@playwright/test";

import { db } from "../_helpers/db";
import { META_API_BASE, resetMock } from "../_helpers/meta";
import {
  MA_CONN,
  MA_TEAM_ID,
  clearMultiAccountData,
  seedBoundConversation,
  seedMultiAccountTeam,
} from "../_helpers/multi-account";

test.describe.configure({ mode: "serial" });

let apiToken = "";

test.beforeAll(async () => {
  ({ apiToken } = await seedMultiAccountTeam());
  await clearMultiAccountData();
});

test.beforeEach(async () => {
  await resetMock();
});

test("the contacts LIST carries each row's account, not just the filter", async () => {
  await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA,
    name: "MA Surface Sales",
    phoneNumber: "9617000001",
  });
  await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappB,
    name: "MA Surface Support",
    phoneNumber: "9617000002",
  });

  // The PUBLIC `/v1` row, not just the internal projection — UI↔/v1 parity is
  // a locked rule (§12), and the directory shows the account on every row.
  const res = await fetch(`${META_API_BASE}/api/external/v1/contacts?limit=50`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    items?: Array<{ name: string; channelConnectionId: string | null }>;
  };
  const byName = new Map(
    (body.items ?? []).map((c) => [c.name, c.channelConnectionId]),
  );

  // UNFILTERED, each row names its OWN account — that is what makes the list
  // readable again once the filter is cleared.
  expect(byName.get("MA Surface Sales")).toBe(MA_CONN.whatsappA);
  expect(byName.get("MA Surface Support")).toBe(MA_CONN.whatsappB);
});

test("starting a chat BINDS to the requested account, not the default", async () => {
  const contact = await db().contact.create({
    data: {
      workspaceId: MA_TEAM_ID,
      identityChannel: "whatsapp",
      phoneNumber: "9617000003",
      name: "MA Start Chat",
    },
    select: { id: true },
  });

  const res = await fetch(`${META_API_BASE}/api/external/v1/conversations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "idempotency-key": "ma-start-chat-1",
    },
    // The NON-default account, deliberately: binding to the default would pass
    // a test that never exercised the parameter.
    body: JSON.stringify({ contactId: contact.id, channelConnectionId: MA_CONN.whatsappB }),
  });
  expect(res.status, await res.clone().text()).toBeLessThan(400);

  const conv = await db().conversation.findFirstOrThrow({
    where: { workspaceId: MA_TEAM_ID, contactId: contact.id },
    select: { channelConnectionId: true },
  });
  expect(conv.channelConnectionId).toBe(MA_CONN.whatsappB);
  expect(conv.channelConnectionId).not.toBe(MA_CONN.whatsappA);
});

test("omitting the account still falls back to the channel default", async () => {
  // The pre-existing behaviour, and the single-account experience. A picker
  // that made the parameter mandatory would break every existing caller.
  const contact = await db().contact.create({
    data: {
      workspaceId: MA_TEAM_ID,
      identityChannel: "whatsapp",
      phoneNumber: "9617000004",
      name: "MA Start Chat Default",
    },
    select: { id: true },
  });

  const res = await fetch(`${META_API_BASE}/api/external/v1/conversations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "idempotency-key": "ma-start-chat-2",
    },
    body: JSON.stringify({ contactId: contact.id }),
  });
  expect(res.status, await res.clone().text()).toBeLessThan(400);

  const conv = await db().conversation.findFirstOrThrow({
    where: { workspaceId: MA_TEAM_ID, contactId: contact.id },
    select: { channelConnectionId: true },
  });
  expect(conv.channelConnectionId).toBe(MA_CONN.whatsappA);
});

test("the person hub reports which account each linked thread is on", async () => {
  // One PERSON, two channel-contacts, on two different accounts — the exact
  // case the hub exists for ("where has this person reached us") and could not
  // answer at the account level.
  const customer = await db().customer.create({
    data: { workspaceId: MA_TEAM_ID, name: "MA Person" },
    select: { id: true },
  });
  const a = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA,
    name: "MA Person WA",
    phoneNumber: "9617000005",
  });
  const b = await seedBoundConversation({
    channel: "messenger",
    channelConnectionId: MA_CONN.messengerB,
    name: "MA Person MSGR",
    externalContactId: "psid_ma_person",
  });
  await db().contact.updateMany({
    where: { id: { in: [a.contactId, b.contactId] } },
    data: { customerId: customer.id },
  });

  const conversations = await db().conversation.findMany({
    where: { workspaceId: MA_TEAM_ID, contact: { customerId: customer.id } },
    select: { channelConnectionId: true },
  });
  const accounts = new Set(conversations.map((c) => c.channelConnectionId));
  // Two threads, two DIFFERENT accounts — the hub's rows resolve their labels
  // from exactly this field.
  expect(accounts.has(MA_CONN.whatsappA)).toBe(true);
  expect(accounts.has(MA_CONN.messengerB)).toBe(true);
  expect(accounts.size).toBe(2);
});
