/**
 * Broadcast DELIVERY TRUTH — the correctness fix behind campaign reporting.
 *
 * THE BUG: Meta accepts a send, then later reports it undeliverable via an async
 * `failed` status webhook. That webhook updated the Message row but never the
 * BroadcastRecipient, so the recipient stayed `status='sent'` and counted as a
 * success. "Who never received it" — the question every client asks — was
 * answered wrongly.
 *
 * These specs drive the REAL pipeline: genuinely HMAC-signed WhatsApp status
 * webhooks → meta.parseWebhook → ingestStatusUpdate → applyBroadcastDeliveryStatus,
 * asserting the committed BroadcastRecipient state. They also pin the two
 * ordering hazards that make this subtle:
 *   - a late `failed` must NOT overwrite a handset-confirmed delivery/read
 *     (Meta batches delivered+failed for one wamid; accepting it would move a
 *     genuinely-received message into "never received"),
 *   - a terminal state never leaves.
 *
 * Runs against the throwaway META_TEST_TEAM_ID; does NOT wipe (mirrors
 * outbound-send.spec.ts — only the terminal webhook-ingest spec wipes, to
 * respect the api's 60s provider-config cache).
 */

import { test, expect } from "@playwright/test";

import { db, pollUntil } from "../_helpers/db";
import {
  seedMetaTestTeam,
  postMetaWebhook,
  META_TEST_TEAM_ID,
  WA_PHONE_NUMBER_ID,
  WA_WABA_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

const PREFIX = "e2e_delivery_";
let broadcastId: string;

test.beforeAll(async () => {
  // Seed ONLY if the fixture isn't already there. `seedMetaTestTeam()` deletes
  // every TeamApiKey for the test team and mints a fresh one, so calling it
  // invalidates the token any previously-run spec is still holding — and the
  // api caches key lookups, which makes the resulting 401 timing-dependent and
  // land on a different spec each run. This spec authenticates with HMAC-signed
  // webhooks and Prisma, never an API key, so it has no reason to rotate them.
  const connected = await db().channelConnection.findUnique({
    where: { teamId_channel: { teamId: META_TEST_TEAM_ID, channel: "whatsapp" } },
    select: { id: true },
  });
  if (!connected) await seedMetaTestTeam();

  const b = await db().broadcast.create({
    data: {
      teamId: META_TEST_TEAM_ID,
      status: "completed",
      kind: "template",
      targetMode: "contact",
      channel: "whatsapp",
      templateName: `${PREFIX}promo`,
      templateLanguage: "en",
      variables: { body: [] },
      audienceMode: "all",
      totalCount: 0,
    },
    select: { id: true },
  });
  broadcastId = b.id;
});

test.afterAll(async () => {
  const rows = await db().broadcast.findMany({
    where: { templateName: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await db().broadcastRecipient.deleteMany({ where: { broadcastId: { in: ids } } });
    await db().broadcast.deleteMany({ where: { id: { in: ids } } });
  }
  await db().contact.deleteMany({
    where: { teamId: META_TEST_TEAM_ID, name: { startsWith: PREFIX } },
  });
});

/**
 * Seed one recipient of the campaign in the post-send state the runner leaves:
 * status='sent', deliveryState='sent', a wamid, and the matching Message row
 * carrying the durable broadcastId (the link the propagation rides).
 */
async function seedSentRecipient(tag: string) {
  const wamid = `wamid.${PREFIX}${tag}.${Date.now()}`;
  const contact = await db().contact.create({
    data: {
      teamId: META_TEST_TEAM_ID,
      name: `${PREFIX}${tag}`,
      phoneNumber: `+1555${Math.floor(1000000 + Math.random() * 8999999)}`,
      identityChannel: "whatsapp",
      source: "manual",
    },
    select: { id: true },
  });
  const conversation = await db().conversation.create({
    data: {
      teamId: META_TEST_TEAM_ID,
      contactId: contact.id,
      channel: "whatsapp",
      status: "pending",
      lastMessagePreview: "",
    },
    select: { id: true },
  });
  await db().message.create({
    data: {
      teamId: META_TEST_TEAM_ID,
      conversationId: conversation.id,
      externalId: wamid,
      body: "campaign",
      direction: "out",
      channel: "whatsapp",
      status: "sent",
      broadcastId,
      timestamp: new Date(),
    },
  });
  const recipient = await db().broadcastRecipient.create({
    data: {
      broadcastId,
      contactId: contact.id,
      conversationId: conversation.id,
      status: "sent",
      deliveryState: "sent",
      externalId: wamid,
      sentAt: new Date(),
    },
    select: { id: true },
  });
  return { recipientId: recipient.id, wamid };
}

/** A genuinely-signed WhatsApp status webhook. */
async function postStatus(
  wamid: string,
  status: "delivered" | "read" | "failed",
  errors?: Array<{ code: number; title: string; error_data?: { details: string } }>,
) {
  return postMetaWebhook(META_TEST_TEAM_ID, {
    object: "whatsapp_business_account",
    entry: [
      {
        id: WA_WABA_ID,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15550001111",
                phone_number_id: WA_PHONE_NUMBER_ID,
              },
              statuses: [
                {
                  id: wamid,
                  status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: "15551234567",
                  ...(errors ? { errors } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

function recipient(id: string) {
  return db().broadcastRecipient.findUnique({
    where: { id },
    select: {
      status: true,
      deliveryState: true,
      deliveredAt: true,
      readAt: true,
      errorCode: true,
      metaErrorCode: true,
    },
  });
}

test("delivered → read advances the recipient's delivery ladder with timestamps", async () => {
  const { recipientId, wamid } = await seedSentRecipient("ladder");

  expect((await postStatus(wamid, "delivered")).status).toBe(200);
  const afterDelivered = await pollUntil(
    async () => {
      const r = await recipient(recipientId);
      return r?.deliveryState === "delivered" ? r : null;
    },
    { label: "deliveryState=delivered" },
  );
  expect(afterDelivered.deliveredAt).not.toBeNull();

  expect((await postStatus(wamid, "read")).status).toBe(200);
  const afterRead = await pollUntil(
    async () => {
      const r = await recipient(recipientId);
      return r?.deliveryState === "read" ? r : null;
    },
    { label: "deliveryState=read" },
  );
  expect(afterRead.readAt).not.toBeNull();
  // The send-side status is runner-owned and must never be touched by a webhook.
  expect(afterRead.status).toBe("sent");
});

test("THE FIX: an accepted-then-failed message becomes `undelivered`, not a silent success", async () => {
  const { recipientId, wamid } = await seedSentRecipient("undeliv");

  // 131049 = Meta's per-user marketing frequency cap. It only ever arrives
  // post-acceptance, so before this fix it was completely invisible.
  expect(
    (
      await postStatus(wamid, "failed", [
        {
          code: 131049,
          title: "Message not delivered",
          error_data: { details: "healthy ecosystem engagement" },
        },
      ])
    ).status,
  ).toBe(200);

  const r = await pollUntil(
    async () => {
      const row = await recipient(recipientId);
      return row?.deliveryState === "undelivered" ? row : null;
    },
    { label: "deliveryState=undelivered" },
  );
  // Normalized into the SAME vocabulary the send path uses, so the failure
  // report is one GROUP BY rather than two taxonomies.
  expect(r.errorCode).toBe("per_user_marketing_cap");
  expect(r.metaErrorCode).toBe(131049);
  // Still `sent` on the send side — Meta did accept it (and bill for it).
  // That's exactly why the funnel must read deliveryState, never status.
  expect(r.status).toBe("sent");
});

/**
 * Read the recipient `samples` times, `intervalMs` apart, and require every read
 * to be identical. Proves the losing webhook was processed AND changed nothing,
 * instead of sampling once and possibly just beating it to the database.
 */
async function expectStableFor(
  recipientId: string,
  samples: number,
  intervalMs: number,
): Promise<void> {
  const seen: string[] = [];
  for (let i = 0; i < samples; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const r = await recipient(recipientId);
    seen.push(JSON.stringify({ d: r?.deliveryState, e: r?.errorCode }));
  }
  expect(
    new Set(seen).size,
    `recipient state churned across reads: ${seen.join(" -> ")}`,
  ).toBe(1);
}

test("ordering hazard: a late `failed` must NOT overwrite a confirmed read", async () => {
  const { recipientId, wamid } = await seedSentRecipient("lateFail");

  expect((await postStatus(wamid, "read")).status).toBe(200);
  await pollUntil(
    async () => {
      const r = await recipient(recipientId);
      return r?.deliveryState === "read" ? r : null;
    },
    { label: "deliveryState=read" },
  );

  // Meta batches delivered+failed for one wamid more often than you'd expect.
  // If the handset already acked, a later failure is a duplicate, not a
  // regression — accepting it would move a received message into "never
  // received" and corrupt the headline number.
  expect((await postStatus(wamid, "failed", [{ code: 131026, title: "Undeliverable" }])).status).toBe(200);
  // These two tests assert a NEGATIVE — that a losing status did NOT move the
  // ladder. There is no positive signal to poll for (the guard's whole job is
  // to write nothing), so we wait out the fire-and-forget ingest and then
  // confirm the value is STABLE rather than merely not-yet-arrived.
  //
  // A single fixed sleep made both tests flaky under full-suite load: they
  // passed alone and intermittently failed in the suite. The product code is
  // fine — the winning path is a CAS with a retry loop, and the losing branch
  // writes only pricing fields, never deliveryState/errorCode. The TEST was the
  // race, not the ingest.
  await expectStableFor(recipientId, 3, 700);

  const r = await recipient(recipientId);
  expect(r?.deliveryState).toBe("read");
  expect(r?.errorCode).toBeNull();
});

test("terminal state never leaves: `delivered` after `undelivered` is ignored", async () => {
  const { recipientId, wamid } = await seedSentRecipient("terminal");

  expect((await postStatus(wamid, "failed", [{ code: 131026, title: "Undeliverable" }])).status).toBe(200);
  await pollUntil(
    async () => {
      const r = await recipient(recipientId);
      return r?.deliveryState === "undelivered" ? r : null;
    },
    { label: "deliveryState=undelivered" },
  );

  expect((await postStatus(wamid, "delivered")).status).toBe(200);
  // These two tests assert a NEGATIVE — that a losing status did NOT move the
  // ladder. There is no positive signal to poll for (the guard's whole job is
  // to write nothing), so we wait out the fire-and-forget ingest and then
  // confirm the value is STABLE rather than merely not-yet-arrived.
  //
  // A single fixed sleep made both tests flaky under full-suite load: they
  // passed alone and intermittently failed in the suite. The product code is
  // fine — the winning path is a CAS with a retry loop, and the losing branch
  // writes only pricing fields, never deliveryState/errorCode. The TEST was the
  // race, not the ingest.
  await expectStableFor(recipientId, 3, 700);

  const r = await recipient(recipientId);
  expect(r?.deliveryState).toBe("undelivered");
  expect(r?.errorCode).toBe("invalid_recipient");
});
