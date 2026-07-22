/**
 * Meta IDENTITY CAPTURE — the two paths by which a contact acquires a strong
 * identity key, end to end through the real pipeline (HMAC verify →
 * provider.parseWebhook → ingest → Prisma), asserting committed DB state.
 *
 *   WhatsApp BSUID (2026 rollout)
 *     - `contacts[].user_id` / `username` land on Contact.bsuid / Contact.username
 *       (Meta puts them on `contacts[]`, NOT on `messages[]`)
 *     - a phone-less webhook (`from` = BSUID) resolves by BSUID and must NEVER
 *       digit-strip "LB.946…" into a fabricated phone number
 *
 *   Social consent chips (Messenger / Instagram)
 *     - a tapped `user_email` chip writes Contact.email and auto-merges the
 *       person into the unified Customer that already owns the same email
 *     - the correlation guard: Meta's inbound frame for a tapped chip is
 *       IDENTICAL to a normal text quick-reply, so a reply is only treated as a
 *       share when the preceding outbound message actually offered that chip,
 *       and never when the payload matches an authored option id
 */

import { test, expect } from "@playwright/test";
import { Prisma } from "@prisma/client";

import { db } from "../_helpers/db";
import {
  seedMetaTestTeam,
  postMetaWebhook,
  META_TEST_TEAM_ID,
  MSGR_PAGE_ID,
  WA_PHONE_NUMBER_ID,
  WA_WABA_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

// Seed idempotently, and do NOT wipe here. Only the last spec (`webhook-ingest`)
// wipes: a mid-run delete→reseed strands the isolated api's 60s provider-config
// cache on a ChannelConnection that no longer exists, and every later spec's
// social webhooks stop ingesting. See the note in `outbound-send.spec.ts`.
test.beforeAll(async () => {
  await seedMetaTestTeam();
});

// ─── WhatsApp BSUID / username ─────────────────────────────────────────────

/** `contacts[]` is where Meta stamps identity — wa_id, user_id (BSUID), username. */
function waEnvelope(opts: {
  mid: string;
  from: string;
  text: string;
  contact: Record<string, unknown>;
}): unknown {
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
              contacts: [opts.contact],
              messages: [
                {
                  from: opts.from,
                  id: opts.mid,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: opts.text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

test("WhatsApp contacts[].user_id + username land on the contact as bsuid/username", async () => {
  const phone = "15551239001";
  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    waEnvelope({
      mid: "wamid.bsuid.1",
      from: phone,
      text: "hi from a phone-known contact",
      contact: {
        wa_id: phone,
        user_id: "LB.946402411360800",
        username: "janedoe",
        profile: { name: "Jane BSUID" },
      },
    }),
  );
  expect(res.status).toBe(200);

  const contact = await db().contact.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, identityChannel: "whatsapp", phoneNumber: phone },
    select: { bsuid: true, username: true, phoneNumber: true, name: true },
  });
  expect(contact?.phoneNumber).toBe(phone);
  expect(contact?.bsuid).toBe("LB.946402411360800");
  expect(contact?.username).toBe("janedoe");
});

test("a phone-less WhatsApp webhook resolves by BSUID and never fabricates a phone", async () => {
  const bsuid = "LB.946402411360999";
  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    waEnvelope({
      mid: "wamid.bsuid.2",
      // Meta omits wa_id for a contact we haven't messaged in 30 days; `from` is
      // then the BSUID. Digit-stripping it would mint the phone "946402411360999".
      from: bsuid,
      text: "hi from a cold contact",
      contact: { user_id: bsuid, profile: { name: "Cold Contact" } },
    }),
  );
  expect(res.status).toBe(200);

  const byBsuid = await db().contact.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, identityChannel: "whatsapp", bsuid },
    select: { phoneNumber: true, bsuid: true },
  });
  expect(byBsuid).not.toBeNull();
  expect(byBsuid?.phoneNumber).toBeNull();

  // The mangled-digits contact must not exist.
  const fabricated = await db().contact.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, phoneNumber: "946402411360999" },
    select: { id: true },
  });
  expect(fabricated).toBeNull();
});

// ─── Social consent chips → strong key → auto-merge ────────────────────────

/** Inbound quick-reply tap. Meta puts the value in BOTH `text` and `payload`. */
function socialQuickReply(o: { senderId: string; mid: string; payload: string }): unknown {
  const ts = Date.now();
  return {
    object: "page",
    entry: [
      {
        id: MSGR_PAGE_ID,
        time: ts,
        messaging: [
          {
            sender: { id: o.senderId },
            recipient: { id: MSGR_PAGE_ID },
            timestamp: ts,
            message: { mid: o.mid, text: o.payload, quick_reply: { payload: o.payload } },
          },
        ],
      },
    ],
  };
}

/**
 * Seed the OUTBOUND message that offered the chips. That row's
 * `rawPayload.interactive.contactShare` is the only trustworthy signal that a
 * following reply is a shared phone/email — Meta's wire frame carries none.
 */
async function seedOffer(
  conversationId: string,
  interactive: Prisma.InputJsonObject,
  externalId: string,
) {
  await db().message.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      conversationId,
      externalId,
      channel: "messenger",
      direction: "out",
      status: "sent",
      body: "Can you share your contact details?",
      timestamp: new Date(),
      rawPayload: { sentVia: "e2e", interactive },
    },
  });
}

async function socialConversationFor(senderId: string): Promise<string> {
  // First inbound creates the contact + conversation.
  await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialQuickReply({ senderId, mid: `mid.seed.${senderId}`, payload: "hello" }),
  );
  const contact = await db().contact.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, identityChannel: "messenger", externalContactId: senderId },
    select: { conversations: { select: { id: true }, take: 1 } },
  });
  const conversationId = contact?.conversations[0]?.id;
  expect(conversationId).toBeTruthy();
  return conversationId!;
}

test("a tapped user_email chip writes Contact.email and merges into the matching Customer", async () => {
  const senderId = "psid_share_email";
  const email = "shared.person@example.com";
  const conversationId = await socialConversationFor(senderId);

  // A WhatsApp contact for the SAME person already carries this email, under its
  // own Customer. The share should fuse them.
  const waCustomer = await db().customer.create({
    data: { workspaceId: META_TEST_TEAM_ID, name: "Shared Person" },
    select: { id: true },
  });
  await db().contact.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      identityChannel: "whatsapp",
      phoneNumber: "15551239777",
      email,
      name: "Shared Person",
      customerId: waCustomer.id,
    },
  });

  await seedOffer(
    conversationId,
    { kind: "buttons", options: [{ id: "later", title: "Not now" }], contactShare: ["email"] },
    "mid.offer.email",
  );

  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialQuickReply({ senderId, mid: "mid.tap.email", payload: email }),
  );
  expect(res.status).toBe(200);

  const social = await db().contact.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, identityChannel: "messenger", externalContactId: senderId },
    select: { email: true, customerId: true },
  });
  expect(social?.email).toBe(email);
  // Auto-merge on the exact-email strong key — one person, two channels.
  expect(social?.customerId).toBe(waCustomer.id);
});

test("a reply matching an authored option id is never mistaken for a shared email", async () => {
  const senderId = "psid_option_collision";
  const conversationId = await socialConversationFor(senderId);

  // The author gave an option the id `sales@acme.com`. Tapping it must NOT
  // overwrite the customer's email with the business's address.
  await seedOffer(
    conversationId,
    {
      kind: "buttons",
      options: [{ id: "sales@acme.com", title: "Talk to sales" }],
      contactShare: ["email"],
    },
    "mid.offer.collision",
  );

  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialQuickReply({ senderId, mid: "mid.tap.collision", payload: "sales@acme.com" }),
  );
  expect(res.status).toBe(200);

  const social = await db().contact.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, identityChannel: "messenger", externalContactId: senderId },
    select: { email: true },
  });
  expect(social?.email).toBeNull();
});

test("a quick-reply with no preceding chip offer never writes an identity key", async () => {
  const senderId = "psid_uncorrelated";
  const conversationId = await socialConversationFor(senderId);

  // An ordinary interactive message — no contactShare offered.
  await seedOffer(
    conversationId,
    { kind: "buttons", options: [{ id: "yes", title: "Yes" }] },
    "mid.offer.plain",
  );

  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialQuickReply({ senderId, mid: "mid.tap.uncorrelated", payload: "stray@example.com" }),
  );
  expect(res.status).toBe(200);

  const social = await db().contact.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, identityChannel: "messenger", externalContactId: senderId },
    select: { email: true },
  });
  expect(social?.email).toBeNull();
});

test("an email tap is ignored when only the phone chip was offered", async () => {
  const senderId = "psid_wrong_kind";
  const conversationId = await socialConversationFor(senderId);

  await seedOffer(
    conversationId,
    { kind: "buttons", options: [], contactShare: ["phone"] },
    "mid.offer.phoneonly",
  );

  const res = await postMetaWebhook(
    META_TEST_TEAM_ID,
    socialQuickReply({ senderId, mid: "mid.tap.wrongkind", payload: "nope@example.com" }),
  );
  expect(res.status).toBe(200);

  const social = await db().contact.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, identityChannel: "messenger", externalContactId: senderId },
    select: { email: true, phoneNumber: true },
  });
  expect(social?.email).toBeNull();
  expect(social?.phoneNumber).toBeNull();
});
