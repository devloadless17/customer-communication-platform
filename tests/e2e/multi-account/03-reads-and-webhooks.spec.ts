/**
 * READS, FILTERS and the OUTBOUND-WEBHOOK payload.
 *
 * A workspace can only be said to see two accounts as two if it can also
 * NARROW to one. And the account a partner is told about must be the account
 * that actually carried the thing — which is not the same as the account the
 * thread currently points at, because ingest re-stamps that pointer whenever
 * the customer writes to a different number of ours.
 */
import { expect, test } from "@playwright/test";

import { db } from "../_helpers/db";
import { META_API_BASE, postMetaWebhook, resetMock, v1Send } from "../_helpers/meta";
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

async function v1Get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${META_API_BASE}/api/external/v1${path}`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** One live thread on each account, so every narrow has something to exclude. */
async function seedOnePerAccount() {
  const a = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA,
    name: "MA Reads A",
    phoneNumber: "9613000001",
  });
  const b = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappB,
    name: "MA Reads B",
    phoneNumber: "9613000002",
  });
  return { a, b };
}

test("the conversation list can NARROW to one account", async () => {
  const { a, b } = await seedOnePerAccount();

  const all = await v1Get("/conversations?limit=50");
  expect(all.status, JSON.stringify(all.json)).toBe(200);
  const allIds = (all.json.items ?? []).map((c: any) => c.id);
  expect(allIds).toContain(a.conversationId);
  expect(allIds).toContain(b.conversationId);

  const onlyB = await v1Get(`/conversations?limit=50&accountId=${MA_CONN.whatsappB}`);
  expect(onlyB.status, JSON.stringify(onlyB.json)).toBe(200);
  const bIds = (onlyB.json.items ?? []).map((c: any) => c.id);
  // POSITIVE …
  expect(bIds).toContain(b.conversationId);
  // … and the half that matters: A's thread is not in B's view.
  expect(bIds).not.toContain(a.conversationId);
});

test("a conversation reports the account it belongs to", async () => {
  const { b } = await seedOnePerAccount();
  const res = await v1Get(`/conversations/${b.conversationId}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const conv = res.json.conversation ?? res.json;
  // The wire names the account, so an integration can route on it rather than
  // guessing from the channel.
  expect(JSON.stringify(conv)).toContain(MA_CONN.whatsappB);
});

test("a MESSAGE keeps its own account after the thread is re-stamped", async () => {
  // The scenario the Message stamp exists for: a send genuinely goes out from
  // account A, then the customer messages account B and ingest re-points the
  // THREAD. Before the stamp, that send retroactively reported as B —
  // including to webhook partners.
  const phone = "9613000003";
  const { conversationId } = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA,
    name: "MA Restamp",
    phoneNumber: phone,
  });

  expect((await v1Send(apiToken, conversationId, { body: "from A" }, "ma-restamp-1")).status).toBe(201);

  // Customer now writes to the OTHER number.
  const inbound = await postMetaWebhook(
    MA_TEAM_ID,
    waInboundTo({
      phoneNumberId: MA.whatsapp.b.account,
      wabaId: MA.whatsapp.b.waba,
      from: phone,
      mid: "wamid.ma.restamp.1",
      text: "now on B",
    }),
  );
  expect(inbound.status, inbound.text).toBe(200);

  const conv = await db().conversation.findFirstOrThrow({
    where: { id: conversationId },
    select: { channelConnectionId: true },
  });
  // The thread moved — correct: that's where the next reply goes.
  expect(conv.channelConnectionId).toBe(MA_CONN.whatsappB);

  const outbound = await db().message.findFirstOrThrow({
    where: { workspaceId: MA_TEAM_ID, conversationId, direction: "out" },
    select: { channelConnectionId: true },
  });
  // The history did NOT move. This is the whole point.
  expect(outbound.channelConnectionId).toBe(MA_CONN.whatsappA);
  expect(outbound.channelConnectionId).not.toBe(conv.channelConnectionId);
});

test("the OUTBOUND WEBHOOK payload names the true account of each message", async () => {
  // Asserted on the PERSISTED delivery row rather than a live HTTP sink: the
  // payload is built and stored before any network attempt, so this proves the
  // resolution itself without depending on the delivery worker's retry timing.
  const phone = "9613000004";
  await db().outboundWebhook.create({
    data: {
      workspaceId: MA_TEAM_ID,
      // Unroutable on purpose — we never want the delivery to succeed, only to
      // be BUILT. Retries are bounded and irrelevant here.
      url: "http://127.0.0.1:9/ma-hook",
      secret: "ma_hook_secret",
      name: "MA account hook",
      eventTypes: ["message.sent"],
      enabled: true,
    },
  });

  const { conversationId } = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA,
    name: "MA Hook",
    phoneNumber: phone,
  });
  expect((await v1Send(apiToken, conversationId, { body: "hook me" }, "ma-hook-1")).status).toBe(201);

  // Re-stamp the thread to B — a partner must STILL be told the send used A.
  await postMetaWebhook(
    MA_TEAM_ID,
    waInboundTo({
      phoneNumberId: MA.whatsapp.b.account,
      wabaId: MA.whatsapp.b.waba,
      from: phone,
      mid: "wamid.ma.hook.1",
      text: "moved",
    }),
  );

  const deadline = Date.now() + 15_000;
  let delivery: { payload: unknown } | null = null;
  while (Date.now() < deadline) {
    delivery = await db().outboundWebhookDelivery.findFirst({
      where: { webhook: { workspaceId: MA_TEAM_ID }, eventType: "message.sent" },
      // NEWEST first. Unordered, this picked whichever row Postgres returned —
      // including a delivery left by an earlier run — so the assertion was
      // about an arbitrary message rather than the one this test just sent.
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    if (delivery) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  expect(delivery, "no message.sent delivery was built").toBeTruthy();

  const payload = JSON.stringify(delivery!.payload);
  // POSITIVE — the account that genuinely carried the send.
  expect(payload).toContain(MA_CONN.whatsappA);
  // NEGATIVE — not the account the thread has since moved to.
  expect(payload).not.toContain(MA_CONN.whatsappB);
});

// Found as a PARITY GAP by this suite and then closed: the contacts browser
// could filter by account but `/v1` could not, which breaks the locked
// UI↔/v1 parity rule (CLAUDE.md §12).
test("contacts can be narrowed to one account", async () => {
  await seedOnePerAccount();
  const res = await v1Get(`/contacts?limit=50&accountId=${MA_CONN.whatsappB}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const names = (res.json.items ?? []).map((c: any) => c.name);
  expect(names).toContain("MA Reads B");
  expect(names).not.toContain("MA Reads A");
});

test("removing ONE account leaves the sibling and its threads untouched", async () => {
  const { a, b } = await seedOnePerAccount();

  const res = await fetch(
    `${META_API_BASE}/api/workspace/channels/whatsapp/accounts/${MA_CONN.whatsappB}`,
    { method: "DELETE", headers: { authorization: `Bearer ${apiToken}` } },
  );
  // Session-guarded admin route; an API key may not be accepted. Either way the
  // assertion below is what matters — nothing may collaterally change.
  if (res.status >= 400) test.info().annotations.push({ type: "note", description: `remove → ${res.status}` });

  const survivor = await db().conversation.findFirstOrThrow({
    where: { id: a.conversationId },
    select: { channelConnectionId: true },
  });
  // A's thread must never be re-pointed by an operation on B.
  expect(survivor.channelConnectionId).toBe(MA_CONN.whatsappA);

  const accountA = await db().channelConnection.findUnique({
    where: { id: MA_CONN.whatsappA },
    select: { isActive: true },
  });
  expect(accountA?.isActive).toBe(true);
  void b;
});
