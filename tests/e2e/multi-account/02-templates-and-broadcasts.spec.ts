/**
 * TEMPLATES + BROADCASTS across two WhatsApp Business Accounts.
 *
 * This is the half of multi-account that only exists because the two numbers
 * sit on DIFFERENT WABAs. The catalog is keyed
 * `(workspaceId, wabaId, name, language)`, so two same-named templates are a
 * legal, everyday state — and sending one from the wrong number is rejected by
 * Meta per-recipient with an opaque error that reaches the operator as "the
 * send just failed".
 *
 * `/v1` sends templates BY NAME (there is no by-id route), so that name lookup
 * is the thing under test here; the by-id guard inside `sendTemplateInternal`
 * is pinned by `apps/api/test/template-account-scope.spec.ts`, which can call
 * it directly.
 */
import { expect, test } from "@playwright/test";

import { db } from "../_helpers/db";
import { META_API_BASE, resetMock, sendAccountIds } from "../_helpers/meta";
import {
  MA,
  MA_CONN,
  MA_TEAM_ID,
  clearMultiAccountData,
  seedBoundConversation,
  seedMultiAccountTeam,
  seedTemplate,
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

/** POST /v1/messages — the n8n-shaped send; templates resolve BY NAME. */
async function v1SendTemplateByName(o: {
  contactId: string;
  name: string;
  idempotencyKey: string;
}): Promise<{ status: number; text: string }> {
  const res = await fetch(`${META_API_BASE}/api/external/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "idempotency-key": o.idempotencyKey,
    },
    body: JSON.stringify({
      contact: { id: o.contactId },
      template: { name: o.name, language: "en_US", variables: { body: [] } },
    }),
  });
  return { status: res.status, text: await res.text() };
}

async function createBroadcast(body: unknown, key: string) {
  const res = await fetch(`${META_API_BASE}/api/external/v1/broadcasts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

test("same-named templates on two WABAs are two DISTINCT rows", async () => {
  const a = await seedTemplate({ name: "order_update", wabaId: MA.whatsapp.a.waba });
  const b = await seedTemplate({ name: "order_update", wabaId: MA.whatsapp.b.waba });
  expect(a.id).not.toBe(b.id);

  const rows = await db().messageTemplate.findMany({
    where: { workspaceId: MA_TEAM_ID, name: "order_update" },
    select: { wabaId: true },
  });
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((r) => r.wabaId))).toEqual(
    new Set([MA.whatsapp.a.waba, MA.whatsapp.b.waba]),
  );
});

test("a name COLLISION resolves to the thread's own catalog", async () => {
  // Both WABAs hold `order_update`. Unscoped, `findFirst` picked whichever row
  // came back first — a coin flip between two legitimately distinct templates,
  // and then an opaque Meta rejection when it guessed wrong.
  await seedTemplate({ name: "order_update", wabaId: MA.whatsapp.a.waba });
  await seedTemplate({ name: "order_update", wabaId: MA.whatsapp.b.waba });
  const { contactId } = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappB,
    name: "MA Collision",
    phoneNumber: "9612000004",
  });

  const res = await v1SendTemplateByName({
    contactId,
    name: "order_update",
    idempotencyKey: "ma-collision-1",
  });
  expect(res.status, res.text).toBe(201);
  // POSITIVE: went out B's number, so B's catalog was the one consulted.
  expect(await sendAccountIds()).toEqual([MA.whatsapp.b.account]);
});

test("a template that exists ONLY on the other WABA is refused, nothing sent", async () => {
  await seedTemplate({ name: "b_only_promo", wabaId: MA.whatsapp.b.waba });
  const { contactId } = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA, // thread replies from A
    name: "MA Cross Waba",
    phoneNumber: "9612000001",
  });

  const res = await v1SendTemplateByName({
    contactId,
    name: "b_only_promo",
    idempotencyKey: "ma-cross-waba-1",
  });
  // It genuinely is not in this account's catalog.
  expect(res.status, res.text).toBeGreaterThanOrEqual(400);
  // NEGATIVE — nothing billed, nothing reached Meta.
  expect(await sendAccountIds()).toHaveLength(0);
});

test("the thread account's OWN template sends from that number", async () => {
  await seedTemplate({ name: "a_promo", wabaId: MA.whatsapp.a.waba });
  const { contactId } = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA,
    name: "MA Right Waba",
    phoneNumber: "9612000002",
  });

  const res = await v1SendTemplateByName({
    contactId,
    name: "a_promo",
    idempotencyKey: "ma-right-waba-1",
  });
  expect(res.status, res.text).toBe(201);
  expect(await sendAccountIds()).toEqual([MA.whatsapp.a.account]);
});

test('a LEGACY ""-WABA template stays sendable from either number', async () => {
  // `""` predates multi-account and belongs to no WABA in particular. Scoping
  // it out would make every pre-multi-account catalog unsendable.
  await seedTemplate({ name: "legacy_notice", wabaId: "" });
  const { contactId } = await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappB,
    name: "MA Legacy",
    phoneNumber: "9612000003",
  });

  const res = await v1SendTemplateByName({
    contactId,
    name: "legacy_notice",
    idempotencyKey: "ma-legacy-1",
  });
  expect(res.status, res.text).toBe(201);
  expect(await sendAccountIds()).toEqual([MA.whatsapp.b.account]);
});

test("a broadcast binds to the account it was created with", async () => {
  const template = await seedTemplate({ name: "promo_b", wabaId: MA.whatsapp.b.waba });
  await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappB,
    name: "MA Campaign Target",
    phoneNumber: "9612000005",
  });

  const res = await createBroadcast(
    {
      name: "MA campaign",
      channel: "whatsapp",
      channelConnectionId: MA_CONN.whatsappB,
      templateId: template.id,
      audience: { mode: "all" },
      scheduledAt: null,
    },
    "ma-broadcast-1",
  );
  expect(res.status, res.text).toBeLessThan(400);

  const broadcast = await db().broadcast.findFirstOrThrow({
    where: { workspaceId: MA_TEAM_ID },
    select: { channelConnectionId: true },
  });
  // POSITIVE / NEGATIVE: bound to B, never silently rebound to the default.
  expect(broadcast.channelConnectionId).toBe(MA_CONN.whatsappB);
  expect(broadcast.channelConnectionId).not.toBe(MA_CONN.whatsappA);
});

test("a broadcast CANNOT be created with the other WABA's template", async () => {
  const aTemplate = await seedTemplate({ name: "promo_a", wabaId: MA.whatsapp.a.waba });
  await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappB,
    name: "MA Wrong Campaign Target",
    phoneNumber: "9612000006",
  });

  const res = await createBroadcast(
    {
      name: "MA wrong campaign",
      channel: "whatsapp",
      channelConnectionId: MA_CONN.whatsappB, // B's number…
      templateId: aTemplate.id, // …A's template
      audience: { mode: "all" },
      scheduledAt: null,
    },
    "ma-broadcast-wrong-1",
  );
  expect(res.status, res.text).toBeGreaterThanOrEqual(400);
  expect(res.text).toContain("template_wrong_account");
  // Refused BEFORE a single recipient row is written — the whole point of
  // guarding at campaign creation rather than per-recipient.
  expect(
    await db().broadcastRecipient.count({ where: { broadcast: { workspaceId: MA_TEAM_ID } } }),
  ).toBe(0);
});

test("a campaign's audience is scoped to its OWN account by default", async () => {
  const template = await seedTemplate({ name: "promo_scoped", wabaId: MA.whatsapp.b.waba });
  // One contact on each account.
  await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappA,
    name: "MA Audience A",
    phoneNumber: "9612000007",
  });
  await seedBoundConversation({
    channel: "whatsapp",
    channelConnectionId: MA_CONN.whatsappB,
    name: "MA Audience B",
    phoneNumber: "9612000008",
  });

  const res = await createBroadcast(
    {
      name: "MA scoped campaign",
      channel: "whatsapp",
      channelConnectionId: MA_CONN.whatsappB,
      templateId: template.id,
      audience: { mode: "all" },
      scheduledAt: null,
      // includeOtherAccounts defaults false — A's customer has never messaged
      // B's number, so reaching them would show an unfamiliar sender.
    },
    "ma-broadcast-scoped-1",
  );
  expect(res.status, res.text).toBeLessThan(400);

  const recipientPhones = (
    await db().broadcastRecipient.findMany({
      where: { broadcast: { workspaceId: MA_TEAM_ID } },
      select: { contact: { select: { phoneNumber: true } } },
    })
  ).map((r) => r.contact?.phoneNumber);

  expect(recipientPhones).toContain("9612000008"); // B's customer
  expect(recipientPhones).not.toContain("9612000007"); // A's customer, excluded
});
