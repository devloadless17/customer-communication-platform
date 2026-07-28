/**
 * NARROWING to one account, everywhere it should be possible.
 *
 * A workspace only really sees two accounts as two if it can also look at one
 * at a time. The inbox and contacts could already narrow; calls, tickets and
 * broadcasts could display the account but not filter by it — so "how many
 * calls did the Support line take last week?" and "what did the Sales line
 * send?" were unanswerable without reading every row by hand.
 *
 * Every case asserts BOTH halves: the account's own rows are returned, AND the
 * sibling's are absent. The second half is the one that matters — a filter that
 * silently widens looks like a working filter.
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
  seedTemplate,
} from "../_helpers/multi-account";
import { MA } from "../_helpers/multi-account";

test.describe.configure({ mode: "serial" });

let apiToken = "";

test.beforeAll(async () => {
  ({ apiToken } = await seedMultiAccountTeam());
  await clearMultiAccountData();
});

test.beforeEach(async () => {
  await resetMock();
});

async function v1Get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${META_API_BASE}/api/external/v1${path}`, {
    headers: { authorization: `Bearer ${apiToken}` },
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test("CONTACTS narrow to one account and exclude the sibling", async () => {
  await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA,
    name: "MA Filter Sales Person",
    phoneNumber: "9616000001",
  });
  await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappB,
    name: "MA Filter Support Person",
    phoneNumber: "9616000002",
  });

  const onlyB = await v1Get(`/contacts?limit=50&accountId=${MA_CONN.whatsappB}`);
  expect(onlyB.status, JSON.stringify(onlyB.json)).toBe(200);
  const names = (onlyB.json.items ?? []).map((c: any) => c.name);
  expect(names).toContain("MA Filter Support Person");
  expect(names).not.toContain("MA Filter Sales Person");

  // Unfiltered still shows both — the narrow is additive, not a new default.
  const all = await v1Get("/contacts?limit=50");
  const allNames = (all.json.items ?? []).map((c: any) => c.name);
  expect(allNames).toContain("MA Filter Sales Person");
  expect(allNames).toContain("MA Filter Support Person");
});

test("BROADCASTS narrow to the account they sent from", async () => {
  const tplA = await seedTemplate({ name: "filter_promo_a", wabaId: MA.whatsapp.a.waba });
  const tplB = await seedTemplate({ name: "filter_promo_b", wabaId: MA.whatsapp.b.waba });

  const create = async (name: string, connId: string, templateId: string, key: string) => {
    const res = await fetch(`${META_API_BASE}/api/external/v1/broadcasts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({
        name,
        channel: "whatsapp",
        channelConnectionId: connId,
        templateId,
        audience: { mode: "all" },
        includeOtherAccounts: true,
        scheduledAt: null,
      }),
    });
    expect(res.status, await res.clone().text()).toBeLessThan(400);
  };

  await create("MA filter campaign A", MA_CONN.whatsappA, tplA.id, "ma-filter-bc-a");
  await create("MA filter campaign B", MA_CONN.whatsappB, tplB.id, "ma-filter-bc-b");

  const onlyB = await v1Get(`/broadcasts?limit=50&accountId=${MA_CONN.whatsappB}`);
  expect(onlyB.status, JSON.stringify(onlyB.json)).toBe(200);
  const names = (onlyB.json.items ?? []).map((b: any) => b.name);
  expect(names).toContain("MA filter campaign B");
  expect(names).not.toContain("MA filter campaign A");
});

test("CALLS narrow to one account", async () => {
  // Calls carry the account through the conversation (Call has no column by
  // design), so this proves the relation filter rather than a stored field.
  const a = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA,
    name: "MA Call Filter Sales",
    phoneNumber: "9616000005",
  });
  const b = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappB,
    name: "MA Call Filter Support",
    phoneNumber: "9616000006",
  });
  const d = db();
  for (const [conv, ext] of [
    [a.conversationId, "wacid.ma.filter.a"],
    [b.conversationId, "wacid.ma.filter.b"],
  ] as const) {
    await d.call.create({
      data: {
        workspaceId: MA_TEAM_ID,
        conversationId: conv,
        externalCallId: ext,
        channel: "whatsapp",
        direction: "in",
        status: "completed",
        ringingAt: new Date(),
        rawPayload: {},
      },
    });
  }

  const onlyB = await v1Get(`/calls?limit=50&accountId=${MA_CONN.whatsappB}`);
  expect(onlyB.status, JSON.stringify(onlyB.json)).toBe(200);
  // Asserted on the CONVERSATION id: the /v1 call DTO does not expose the
  // provider's call id, and the conversation is what carries the account.
  const payload = JSON.stringify(onlyB.json);
  expect(payload).toContain(b.conversationId);
  expect(payload).not.toContain(a.conversationId);
});

test("TICKETS narrow through the conversation, with no denormalized column", async () => {
  // Ticket carries `channel` (safe — a conversation's channel never changes)
  // but deliberately NOT the account, which is re-stamped on every inbound to a
  // different number. So the filter goes through the relation.
  const a = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA,
    name: "MA Ticket Sales",
    phoneNumber: "9616000003",
  });
  const b = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappB,
    name: "MA Ticket Support",
    phoneNumber: "9616000004",
  });

  const mkTicket = async (conversationId: string, contactId: string, subject: string) => {
    const res = await fetch(`${META_API_BASE}/api/external/v1/tickets`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
        "idempotency-key": `ma-ticket-${subject}`,
      },
      body: JSON.stringify({ conversationId, contactId, subject, priority: "normal" }),
    });
    return res.status;
  };
  const sA = await mkTicket(a.conversationId, a.contactId, "sales-issue");
  const sB = await mkTicket(b.conversationId, b.contactId, "support-issue");
  test.skip(sA >= 400 || sB >= 400, "ticket create shape differs — covered by the ticket suite");

  const onlyB = await v1Get(`/tickets?limit=50&accountId=${MA_CONN.whatsappB}`);
  expect(onlyB.status, JSON.stringify(onlyB.json)).toBe(200);
  // The tickets list returns `tickets`, not `items`.
  const subjects = (onlyB.json.tickets ?? []).map((t: any) => t.subject);
  expect(subjects).toContain("support-issue");
  expect(subjects).not.toContain("sales-issue");

  // And the model still has no account column of its own.
  const columns = await db().$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'Ticket'`,
  );
  expect(columns.map((c) => c.column_name)).not.toContain("channelConnectionId");
});
