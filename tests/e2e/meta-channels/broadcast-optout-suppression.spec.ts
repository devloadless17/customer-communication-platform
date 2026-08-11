/**
 * CREATE-TIME opt-out suppression — the compliance choke point.
 *
 * broadcast-engagement-optout.spec.ts pins how opt-outs get RECORDED (STOP
 * keyword → `marketingOptOutAt` + recipient `optedOutAt`). What nothing pinned
 * (audit 2026-08-10 test debt) is the other half: that a broadcast CREATED
 * over an audience containing opted-out / blocked contacts actually EXCLUDES
 * them, counts them in `suppressedCount`, and applies the documented gates —
 *
 *   - marketing opt-out suppresses MARKETING templates only (a utility
 *     message must still reach someone who opted out of promos — they asked
 *     for their order updates);
 *   - a provider-level BLOCK suppresses everything, category regardless.
 *
 * Runs in the meta harness (real API at META_API_BASE, mock Graph) through
 * the /v1 create route — the same lib path the UI composer takes.
 */
import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";
import {
  seedMetaTestTeam,
  META_API_BASE,
  META_TEST_TEAM_ID,
  WA_WABA_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

const PREFIX = "e2e_supr_";
const S = String(Date.now()).slice(-7);
let apiToken = "";
const contactIds: string[] = [];
const templateIds: string[] = [];

async function makeTemplate(name: string, category: "marketing" | "utility") {
  const row = await db().messageTemplate.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      wabaAccountId: (
        await db().whatsappBusinessAccount.findUniqueOrThrow({
          where: { externalWabaId: WA_WABA_ID },
          select: { id: true },
        })
      ).id,
      externalId: `tpl_${name}`,
      name,
      language: "en_US",
      category,
      status: "approved",
      bodyText: "Hello there",
      components: [{ type: "BODY", text: "Hello there" }],
      parameterFormat: "positional",
    },
    select: { id: true },
  });
  templateIds.push(row.id);
  return row.id;
}

async function makeContact(
  suffix: string,
  extra: { marketingOptOutAt?: Date; blockedAt?: Date } = {},
) {
  const row = await db().contact.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      name: `${PREFIX}${suffix}`,
      phoneNumber: `+9613${S}${suffix.length}${suffix.charCodeAt(0)}`,
      identityChannel: "whatsapp",
      ...extra,
    },
    select: { id: true },
  });
  contactIds.push(row.id);
  return row.id;
}

async function createBroadcast(body: unknown, idem: string) {
  const res = await fetch(`${META_API_BASE}/api/external/v1/broadcasts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
      "idempotency-key": `${PREFIX}${idem}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

let clean = "";
let optedOut = "";
let blocked = "";

test.beforeAll(async () => {
  const seeded = await seedMetaTestTeam();
  apiToken = seeded.apiToken;
  clean = await makeContact("clean");
  optedOut = await makeContact("opted", { marketingOptOutAt: new Date() });
  blocked = await makeContact("blockd", { blockedAt: new Date() });
});

test.afterAll(async () => {
  const broadcasts = await db().broadcast.findMany({
    where: { workspaceId: META_TEST_TEAM_ID, name: { startsWith: PREFIX } },
    select: { id: true },
  });
  for (const b of broadcasts) {
    await db().broadcastRecipient.deleteMany({ where: { broadcastId: b.id } });
  }
  await db().broadcast.deleteMany({
    where: { id: { in: broadcasts.map((b) => b.id) } },
  });
  await db().messageTemplate.deleteMany({ where: { id: { in: templateIds } } });
  await db().contact.deleteMany({ where: { id: { in: contactIds }, workspaceId: META_TEST_TEAM_ID } });
});

test("a MARKETING broadcast suppresses opted-out AND blocked contacts, and says so", async () => {
  const templateId = await makeTemplate(`${PREFIX}promo`, "marketing");
  const { status, json } = await createBroadcast(
    {
      name: `${PREFIX}marketing`,
      templateId,
      audience: { mode: "selected", contactIds: [clean, optedOut, blocked] },
    },
    "mkt1",
  );
  expect(status, JSON.stringify(json)).toBe(201);

  const row = await db().broadcast.findUniqueOrThrow({
    where: { id: json.broadcastId as string },
    select: { suppressedCount: true, totalCount: true },
  });
  expect(row.suppressedCount).toBe(2);
  expect(row.totalCount).toBe(1);

  const recipients = await db().broadcastRecipient.findMany({
    where: { broadcastId: json.broadcastId as string },
    select: { contactId: true },
  });
  expect(recipients.map((r) => r.contactId)).toEqual([clean]);
});

test("a UTILITY broadcast still reaches the marketing opt-out — only the block suppresses", async () => {
  const templateId = await makeTemplate(`${PREFIX}orderupd`, "utility");
  const { status, json } = await createBroadcast(
    {
      name: `${PREFIX}utility`,
      templateId,
      audience: { mode: "selected", contactIds: [clean, optedOut, blocked] },
    },
    "utl1",
  );
  expect(status, JSON.stringify(json)).toBe(201);

  const row = await db().broadcast.findUniqueOrThrow({
    where: { id: json.broadcastId as string },
    select: { suppressedCount: true, totalCount: true },
  });
  expect(row.suppressedCount).toBe(1);
  expect(row.totalCount).toBe(2);

  const recipients = await db().broadcastRecipient.findMany({
    where: { broadcastId: json.broadcastId as string },
    select: { contactId: true },
    orderBy: { contactId: "asc" },
  });
  expect(new Set(recipients.map((r) => r.contactId))).toEqual(new Set([clean, optedOut]));
});

test("an audience that is ENTIRELY opted out refuses loudly instead of sending to nobody", async () => {
  const templateId = await makeTemplate(`${PREFIX}promo2`, "marketing");
  const { status, json } = await createBroadcast(
    {
      name: `${PREFIX}allout`,
      templateId,
      audience: { mode: "selected", contactIds: [optedOut] },
    },
    "all1",
  );
  expect(status).toBe(400);
  expect(String(json.error)).toContain("opted_out");
});
