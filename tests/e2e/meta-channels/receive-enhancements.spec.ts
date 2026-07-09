/**
 * Meta RECEIVE ENHANCEMENTS — end to end through the real pipeline (HMAC verify
 * → provider.parseWebhook → ingest → Prisma upsert), asserting committed DB
 * state on the throwaway META_TEST_TEAM_ID:
 *
 *   - social unsend (Messenger `is_deleted`) → tombstone (`deletedAt`, body kept)
 *   - social native-inbox echo (`is_echo`) → outbound `business_app` message
 *   - Messenger postback → interactive-reply message (body = title)
 *   - Messenger referral → ad attribution
 *   - WhatsApp location → structured location card
 *   - WhatsApp contacts → structured contact card
 *   - WhatsApp Click-to-WhatsApp referral → ad attribution
 */

import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";
import {
  seedMetaTestTeam,
  postMetaWebhook,
  socialInbound,
  META_TEST_TEAM_ID,
  MSGR_PAGE_ID,
  WA_PHONE_NUMBER_ID,
  WA_WABA_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });
// Seed idempotently (upsert). Deliberately NO afterAll wipe: the isolated api
// caches provider config for 60s and the test wipe doesn't invalidate it, so a
// second delete→reseed cycle within one run stales the cache for the next spec.
// Our external ids are unique, so leaving rows for the final spec's wipe to
// clean up is harmless and keeps every spec's config cache-consistent.
test.beforeAll(async () => {
  await seedMetaTestTeam();
});

function msgByExternalId(channel: "whatsapp" | "messenger" | "instagram", externalId: string) {
  return db().message.findUnique({
    where: { teamId_channel_externalId: { teamId: META_TEST_TEAM_ID, channel, externalId } },
    select: {
      id: true,
      direction: true,
      body: true,
      origin: true,
      deletedAt: true,
      structured: true,
      attribution: true,
    },
  });
}

// ─── Social: unsend / echo / postback / referral ───────────────────────────

test("Messenger unsend (is_deleted) tombstones the message but keeps the body", async () => {
  const psid = "6009000000001";
  const mid = "m.msgr.unsend.1";
  // First the customer sends a message…
  const sent = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialInbound({ object: "page", accountId: MSGR_PAGE_ID, senderId: psid, mid, text: "oops secret" }),
  );
  expect(sent.status).toBe(200);
  const before = await msgByExternalId("messenger", mid);
  expect(before?.deletedAt).toBeNull();
  expect(before?.body).toBe("oops secret");

  // …then unsends it (same mid, is_deleted).
  const del = await postMetaWebhook(META_TEST_TEAM_ID, {
    object: "page",
    entry: [
      {
        id: MSGR_PAGE_ID,
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: MSGR_PAGE_ID },
            timestamp: Date.now(),
            message: { mid, is_deleted: true },
          },
        ],
      },
    ],
  });
  expect(del.status).toBe(200);
  const after = await msgByExternalId("messenger", mid);
  expect(after?.deletedAt).not.toBeNull(); // tombstoned
  expect(after?.body).toBe("oops secret"); // body PRESERVED for the record
});

test("Messenger native-inbox echo (is_echo) creates an outbound business_app message", async () => {
  const psid = "6009000000002";
  const mid = "m.msgr.echo.1";
  const res = await postMetaWebhook(META_TEST_TEAM_ID, {
    object: "page",
    entry: [
      {
        id: MSGR_PAGE_ID,
        messaging: [
          {
            // sender = the PAGE (business), recipient = the customer → an echo.
            sender: { id: MSGR_PAGE_ID },
            recipient: { id: psid },
            timestamp: Date.now(),
            message: { mid, text: "reply typed in Meta's own inbox", is_echo: true },
          },
        ],
      },
    ],
  });
  expect(res.status).toBe(200);
  const echo = await msgByExternalId("messenger", mid);
  expect(echo?.direction).toBe("out");
  expect(echo?.origin).toBe("business_app");
  expect(echo?.body).toBe("reply typed in Meta's own inbox");
});

test("Messenger postback → interactive-reply message (body = title)", async () => {
  const psid = "6009000000003";
  const mid = "m.msgr.postback.1";
  const res = await postMetaWebhook(META_TEST_TEAM_ID, {
    object: "page",
    entry: [
      {
        id: MSGR_PAGE_ID,
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: MSGR_PAGE_ID },
            timestamp: Date.now(),
            postback: { mid, title: "Get started", payload: "GET_STARTED" },
          },
        ],
      },
    ],
  });
  expect(res.status).toBe(200);
  const msg = await msgByExternalId("messenger", mid);
  expect(msg?.body).toBe("Get started");
});

test("Messenger Click-to-Messenger referral → ad attribution", async () => {
  const psid = "6009000000004";
  const mid = "m.msgr.ref.1";
  const res = await postMetaWebhook(META_TEST_TEAM_ID, {
    object: "page",
    entry: [
      {
        id: MSGR_PAGE_ID,
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: MSGR_PAGE_ID },
            timestamp: Date.now(),
            message: { mid, text: "saw your ad" },
            referral: {
              ref: "SUMMER_SALE",
              source: "ADS",
              type: "OPEN_THREAD",
              ad_id: "ad_123",
              ads_context_data: { ad_title: "Summer Sale — 30% off" },
            },
          },
        ],
      },
    ],
  });
  expect(res.status).toBe(200);
  const msg = await msgByExternalId("messenger", mid);
  const attr = msg?.attribution as { source?: string; clickId?: string; headline?: string } | null;
  expect(attr?.source).toBe("ad");
  expect(attr?.clickId).toBe("ad_123");
  expect(attr?.headline).toBe("Summer Sale — 30% off");
});

// ─── WhatsApp: structured media + attribution ──────────────────────────────

function waEnvelope(message: Record<string, unknown>, from = "15551230000"): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: WA_WABA_ID,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: WA_PHONE_NUMBER_ID },
              contacts: [{ wa_id: from, profile: { name: "WA Tester" } }],
              messages: [{ from, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
            },
          },
        ],
      },
    ],
  };
}

test("WhatsApp location → structured location card", async () => {
  const id = "wamid.loc.1";
  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    waEnvelope({
      id,
      type: "location",
      location: { latitude: 33.8938, longitude: 35.5018, name: "Beirut HQ", address: "Downtown, Beirut" },
    }),
  );
  expect(res.status).toBe(200);
  const msg = await msgByExternalId("whatsapp", id);
  const s = msg?.structured as { kind?: string; latitude?: number; name?: string } | null;
  expect(s?.kind).toBe("location");
  expect(s?.latitude).toBeCloseTo(33.8938, 3);
  expect(s?.name).toBe("Beirut HQ");
});

test("WhatsApp contacts → structured contact card", async () => {
  const id = "wamid.contacts.1";
  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    waEnvelope({
      id,
      type: "contacts",
      contacts: [{ name: { formatted_name: "Jane Doe" }, phones: [{ phone: "+15551239999" }] }],
    }),
  );
  expect(res.status).toBe(200);
  const msg = await msgByExternalId("whatsapp", id);
  const s = msg?.structured as { kind?: string; contacts?: Array<{ name: string; phones: string[] }> } | null;
  expect(s?.kind).toBe("contacts");
  expect(s?.contacts?.[0]?.name).toBe("Jane Doe");
  expect(s?.contacts?.[0]?.phones?.[0]).toContain("15551239999");
});

test("WhatsApp Click-to-WhatsApp referral → ad attribution", async () => {
  const id = "wamid.ref.1";
  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    waEnvelope({
      id,
      type: "text",
      text: { body: "came from the ad" },
      referral: {
        source_url: "https://fb.com/ad/1",
        source_type: "ad",
        headline: "Ramadan Offer",
        body: "Tap to chat",
        ctwa_clid: "clid_abc",
      },
    }),
  );
  expect(res.status).toBe(200);
  const msg = await msgByExternalId("whatsapp", id);
  const attr = msg?.attribution as { source?: string; headline?: string; clickId?: string } | null;
  expect(attr?.source).toBe("ad");
  expect(attr?.headline).toBe("Ramadan Offer");
  expect(attr?.clickId).toBe("clid_abc");
});
