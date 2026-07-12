/**
 * Regressions for the 2026-07-10 Meta deep-audit fixes — each asserts committed
 * DB state through the real pipeline (HMAC verify → parseWebhook → ingest):
 *
 *   - Messenger sticker attachment (POST-2026-08-30 shape: `sticker` only)
 *     → a `sticker` media message, not a bare "sticker" text label
 *   - Messenger sticker during the transition (both `sticker` + `image`)
 *     → resolves to `sticker` too, so the cutover is a no-op
 *   - Messenger `reel` / Instagram `ig_reel` → `video` media
 *   - Messenger `message_edits` → the stored body is REWRITTEN
 *   - WhatsApp Flows `nfm_reply` → a placeholder row, not a dropped message
 *   - WhatsApp BSUID cold→warm → ONE contact, not a split identity
 *
 * See docs/meta-channels-capabilities.md.
 */

import { test, expect } from "@playwright/test";

import { db } from "../_helpers/db";
import {
  seedMetaTestTeam,
  postMetaWebhook,
  META_TEST_TEAM_ID,
  MSGR_PAGE_ID,
  IG_ID,
  WA_PHONE_NUMBER_ID,
  WA_WABA_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await seedMetaTestTeam();
});

const uniq = () => Math.random().toString(36).slice(2, 10);

function msgByExternalId(channel: "whatsapp" | "messenger" | "instagram", externalId: string) {
  return db().message.findUnique({
    where: { teamId_channel_externalId: { teamId: META_TEST_TEAM_ID, channel, externalId } },
  });
}

/** A raw social messaging event, so we can send shapes the helpers don't model. */
function socialEvent(
  object: "page" | "instagram",
  accountId: string,
  senderId: string,
  messaging: Record<string, unknown>,
): unknown {
  const ts = Date.now();
  return {
    object,
    entry: [
      {
        id: accountId,
        time: ts,
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: accountId },
            timestamp: ts,
            ...messaging,
          },
        ],
      },
    ],
  };
}

/** A raw WhatsApp `messages` change, so we can drive contacts[]/BSUID shapes. */
function waEvent(value: Record<string, unknown>): unknown {
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
              ...value,
            },
          },
        ],
      },
    ],
  };
}

test("Messenger sticker (post-cutover: only the `sticker` attachment) ingests as sticker media", async () => {
  const mid = `m_sticker_${uniq()}`;
  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialEvent("page", MSGR_PAGE_ID, `psid_${uniq()}`, {
      message: {
        mid,
        attachments: [
          {
            type: "sticker",
            payload: { url: "https://cdn.example.com/sticker.webp", sticker_id: 369239263222822 },
          },
        ],
      },
    }),
  );
  expect(res.status).toBe(200);

  const msg = await msgByExternalId("messenger", mid);
  expect(msg).not.toBeNull();
  // The regression: `attachmentKind` used to return null for "sticker", so the
  // row landed with body "[sticker]" / the label and NO media at all.
  expect(msg!.mediaKind).toBe("sticker");
  expect(msg!.body).toBe("");
});

test("Messenger sticker during Meta's transition (sticker + image both present) still resolves to sticker", async () => {
  const mid = `m_sticker_dual_${uniq()}`;
  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialEvent("page", MSGR_PAGE_ID, `psid_${uniq()}`, {
      message: {
        mid,
        attachments: [
          { type: "sticker", payload: { url: "https://cdn.example.com/s.webp", sticker_id: 1 } },
          { type: "image", payload: { url: "https://cdn.example.com/s.png" } },
        ],
      },
    }),
  );
  expect(res.status).toBe(200);

  const msg = await msgByExternalId("messenger", mid);
  // Preferring `sticker` over the co-delivered `image` is what makes the
  // 2026-08-30 cutover a no-op instead of a silent behavior change.
  expect(msg!.mediaKind).toBe("sticker");
});

test("Messenger `reel` and Instagram `ig_reel` ingest as video media", async () => {
  const reelMid = `m_reel_${uniq()}`;
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialEvent("page", MSGR_PAGE_ID, `psid_${uniq()}`, {
      message: {
        mid: reelMid,
        attachments: [{ type: "reel", payload: { url: "https://cdn.example.com/r.mp4" } }],
      },
    }),
  );
  const igMid = `ig_reel_${uniq()}`;
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialEvent("instagram", IG_ID, `igsid_${uniq()}`, {
      message: {
        mid: igMid,
        attachments: [{ type: "ig_reel", payload: { url: "https://cdn.example.com/ir.mp4" } }],
      },
    }),
  );

  expect((await msgByExternalId("messenger", reelMid))!.mediaKind).toBe("video");
  expect((await msgByExternalId("instagram", igMid))!.mediaKind).toBe("video");
});

test("Messenger message_edits rewrites the stored body", async () => {
  const psid = `psid_edit_${uniq()}`;
  const mid = `m_edit_${uniq()}`;

  await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialEvent("page", MSGR_PAGE_ID, psid, {
      message: { mid, text: "send to 123 Main St" },
    }),
  );
  expect((await msgByExternalId("messenger", mid))!.body).toBe("send to 123 Main St");

  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialEvent("page", MSGR_PAGE_ID, psid, {
      message_edit: { mid, text: "send to 456 Oak Ave", num_edit: 1 },
    }),
  );
  expect(res.status).toBe(200);

  // Previously fell into the `unhandled_messaging` log and was dropped, leaving
  // the agent shipping to the address the customer had already corrected.
  const edited = await msgByExternalId("messenger", mid);
  expect(edited!.body).toBe("send to 456 Oak Ave");
});

test("WhatsApp Flows nfm_reply persists a placeholder instead of dropping the submission", async () => {
  const from = `9611${Math.floor(1000000 + Math.random() * 8999999)}`;
  const wamid = `wamid_nfm_${uniq()}`;

  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    waEvent({
      contacts: [{ wa_id: from, profile: { name: "Flow Tester" } }],
      messages: [
        {
          from,
          id: wamid,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: "interactive",
          interactive: {
            type: "nfm_reply",
            nfm_reply: { name: "flow", response_json: '{"order":"A1"}' },
          },
        },
      ],
    }),
  );
  expect(res.status).toBe(200);

  // The old `continue` emitted nothing: no row, no unread, and — since we 200 the
  // webhook — no Meta redelivery. The submission was gone.
  const msg = await msgByExternalId("whatsapp", wamid);
  expect(msg).not.toBeNull();
  expect(msg!.body).toBe("📝 Form response");
  expect(msg!.direction).toBe("in");
});

test("WhatsApp BSUID cold→warm resolves to ONE contact, not a split identity", async () => {
  const suffix = uniq();
  const bsuid = `LB.${Math.floor(100000000000000 + Math.random() * 899999999999999)}`;
  const phone = `9612${Math.floor(1000000 + Math.random() * 8999999)}`;

  // 1. Cold contact: Meta omits `wa_id`; `from` IS the BSUID.
  const cold = await postMetaWebhook(
    META_TEST_TEAM_ID,
    waEvent({
      contacts: [{ user_id: bsuid, profile: { name: "Cold Caller" } }],
      messages: [
        {
          from: bsuid,
          id: `wamid_cold_${suffix}`,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: "text",
          text: { body: "first contact" },
        },
      ],
    }),
  );
  expect(cold.status).toBe(200);

  const afterCold = await db().contact.findMany({
    where: { teamId: META_TEST_TEAM_ID, bsuid },
  });
  expect(afterCold).toHaveLength(1);
  // A BSUID must never be digit-stripped into a phone number.
  expect(afterCold[0]!.phoneNumber).toBeNull();

  // 2. Warm: the same person, now with `wa_id`; `from` is the phone.
  const warm = await postMetaWebhook(
    META_TEST_TEAM_ID,
    waEvent({
      contacts: [{ wa_id: phone, user_id: bsuid, profile: { name: "Cold Caller" } }],
      messages: [
        {
          from: phone,
          id: `wamid_warm_${suffix}`,
          timestamp: String(Math.floor(Date.now() / 1000) + 1),
          type: "text",
          text: { body: "second contact" },
        },
      ],
    }),
  );
  expect(warm.status).toBe(200);

  // The regression: resolution was phone-only when a phone was present, so the
  // BSUID-keyed row was never found and a SECOND contact + conversation were
  // created, permanently orphaning the first thread.
  const byBsuid = await db().contact.findMany({
    where: { teamId: META_TEST_TEAM_ID, bsuid },
  });
  expect(byBsuid).toHaveLength(1);
  expect(byBsuid[0]!.phoneNumber).toBe(phone);

  const byPhone = await db().contact.findMany({
    where: { teamId: META_TEST_TEAM_ID, phoneNumber: phone },
  });
  expect(byPhone).toHaveLength(1);
  expect(byPhone[0]!.id).toBe(afterCold[0]!.id);

  // Both messages land on the ONE conversation that contact owns.
  const convs = await db().conversation.findMany({
    where: { teamId: META_TEST_TEAM_ID, contactId: afterCold[0]!.id },
  });
  expect(convs).toHaveLength(1);
  const msgs = await db().message.findMany({
    where: { teamId: META_TEST_TEAM_ID, conversationId: convs[0]!.id },
  });
  expect(msgs.map((m) => m.body).sort()).toEqual(["first contact", "second contact"]);
});
