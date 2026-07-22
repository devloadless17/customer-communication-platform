/**
 * Campaign engagement + compliance (phases 2-4), through the REAL pipeline:
 *   - reply attribution (direct quote beats time-window; first reply wins)
 *   - template button click-through, keyed on the STABLE option id
 *   - cost capture from Meta's `pricing` object on the status webhook
 *   - opt-out via STOP keyword, and the adversarial cases that must NOT opt out
 *
 * The opt-out keyword tests are the most important thing in this file. A false
 * positive silently destroys a marketing list and is unrecoverable, so the
 * matcher is exact-whole-body only and these cases pin that.
 */

import { test, expect } from "@playwright/test";

import { isOptOutKeyword } from "../../../apps/api/src/lib/broadcast-attribution";
import { db, pollUntil } from "../_helpers/db";
import {
  seedMetaTestTeam,
  postMetaWebhook,
  META_TEST_TEAM_ID,
  WA_PHONE_NUMBER_ID,
  WA_WABA_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

const PREFIX = "e2e_engage_";
let broadcastId: string;

test.beforeAll(async () => {
  // Seed only if absent — seedMetaTestTeam() rotates the team's API keys, which
  // invalidates tokens other specs hold (see broadcast-delivery-truth.spec.ts).
  const connected = await db().channelConnection.findFirst({
    where: { workspaceId: META_TEST_TEAM_ID, channel: "whatsapp", isDefault: true },
    select: { id: true },
  });
  if (!connected) await seedMetaTestTeam();

  const b = await db().broadcast.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      status: "completed",
      kind: "template",
      targetMode: "contact",
      channel: "whatsapp",
      templateName: `${PREFIX}promo`,
      templateLanguage: "en",
      templateCategory: "MARKETING",
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
    where: { workspaceId: META_TEST_TEAM_ID, name: { startsWith: PREFIX } },
  });
  // The inbound webhook creates its own contact rows named from the WhatsApp
  // profile ("Tester"), so the prefix purge above misses them — clean by the
  // run-unique phone prefix too, or the next run collides on the phone unique.
  await db().contact.deleteMany({
    where: { workspaceId: META_TEST_TEAM_ID, phoneNumber: { startsWith: PHONE_BASE } },
  });
});

// Phones are unique PER RUN: the inbound webhook creates its own contact row
// (named by the WhatsApp profile, not our prefix), so a fixed number would
// collide with the previous run's leftover on the (workspaceId, phoneNumber) unique.
const PHONE_BASE = `1555${String(Date.now()).slice(-6)}`;
let phoneSeq = 0;
/** A recipient in the state the runner leaves after a successful send. */
async function seedRecipient(tag: string) {
  const digits = `${PHONE_BASE}${phoneSeq++}`;
  const wamid = `wamid.${PREFIX}${tag}.${Date.now()}`;
  const contact = await db().contact.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      name: `${PREFIX}${tag}`,
      // Digits-only, NO leading "+": that is how ingest normalizes and stores a
      // WhatsApp number, so seeding "+1555..." creates a contact the inbound
      // webhook will never match (it would silently make a second contact and
      // the attribution would find no recipient).
      phoneNumber: digits,
      identityChannel: "whatsapp",
      source: "manual",
    },
    select: { id: true },
  });
  const conversation = await db().conversation.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      contactId: contact.id,
      channel: "whatsapp",
      status: "pending",
      lastMessagePreview: "",
    },
    select: { id: true },
  });
  const msg = await db().message.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      conversationId: conversation.id,
      externalId: wamid,
      body: "campaign",
      direction: "out",
      channel: "whatsapp",
      status: "sent",
      broadcastId,
      timestamp: new Date(),
    },
    select: { id: true },
  });
  const recipient = await db().broadcastRecipient.create({
    data: {
      broadcastId,
      contactId: contact.id,
      conversationId: conversation.id,
      status: "sent",
      deliveryState: "delivered",
      externalId: wamid,
      sentAt: new Date(Date.now() - 60_000),
    },
    select: { id: true },
  });
  return { recipientId: recipient.id, contactId: contact.id, digits, wamid, messageId: msg.id };
}

/** An inbound WhatsApp message, optionally quoting one of our messages or
 *  carrying a template quick-reply button tap. */
async function postInbound(
  digits: string,
  opts: { body?: string; quoteWamid?: string; button?: { id: string; text: string } } = {},
) {
  const value: Record<string, unknown> = {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550001111", phone_number_id: WA_PHONE_NUMBER_ID },
    contacts: [{ profile: { name: "Tester" }, wa_id: digits }],
    messages: [
      {
        from: digits,
        id: `wamid.in.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        ...(opts.button
          ? { type: "button", button: { payload: opts.button.id, text: opts.button.text } }
          : { type: "text", text: { body: opts.body ?? "hello" } }),
        ...(opts.quoteWamid ? { context: { id: opts.quoteWamid } } : {}),
      },
    ],
  };
  return postMetaWebhook(META_TEST_TEAM_ID, {
    object: "whatsapp_business_account",
    entry: [{ id: WA_WABA_ID, changes: [{ field: "messages", value }] }],
  });
}

function recipient(id: string) {
  return db().broadcastRecipient.findUnique({
    where: { id },
    select: {
      repliedAt: true,
      repliedAttribution: true,
      clickedAt: true,
      clickedOptionId: true,
      optedOutAt: true,
      pricingCategory: true,
      pricingBillable: true,
    },
  });
}

test.describe("opt-out keyword matching (exact whole body ONLY)", () => {
  test("real opt-out phrasings are recognised", () => {
    for (const body of ["stop", "STOP", " Stop ", "STOP.", "unsubscribe", "cancel", "الغاء", "توقف"]) {
      expect(isOptOutKeyword(body), `${body} should opt out`).toBe(true);
    }
  });

  test("ADVERSARIAL: sentences containing a keyword must NOT opt out", () => {
    // A false positive here silently destroys a marketing list, so substring
    // matching is never acceptable — these are the phrasings that would break it.
    for (const body of [
      "please stop sending me the wrong size",
      "I'll stop by tomorrow",
      "can you cancel my order?",
      "do not cancel",
      "stop it already, I love these",
      "when does the offer end",
      "",
      "   ",
    ]) {
      expect(isOptOutKeyword(body), `"${body}" must NOT opt out`).toBe(false);
    }
  });
});

test("a quoted reply is attributed DIRECTLY to the campaign", async () => {
  const r = await seedRecipient("direct");
  expect((await postInbound(r.digits, { body: "yes please", quoteWamid: r.wamid })).status).toBe(200);

  const row = await pollUntil(
    async () => {
      const x = await recipient(r.recipientId);
      return x?.repliedAt ? x : null;
    },
    { label: "repliedAt set (direct)" },
  );
  expect(row.repliedAttribution).toBe("direct");
});

test("an unquoted reply inside the window is attributed by TIME WINDOW", async () => {
  const r = await seedRecipient("window");
  expect((await postInbound(r.digits, { body: "interested" })).status).toBe(200);

  const row = await pollUntil(
    async () => {
      const x = await recipient(r.recipientId);
      return x?.repliedAt ? x : null;
    },
    { label: "repliedAt set (window)" },
  );
  // Stored so the report can footnote how many replies were inferred rather
  // than proven — that's what turns a guess into a measurement.
  expect(row.repliedAttribution).toBe("window");
});

test("only the FIRST reply counts — a second inbound doesn't re-credit", async () => {
  const r = await seedRecipient("firstonly");
  await postInbound(r.digits, { body: "one" });
  const first = await pollUntil(
    async () => {
      const x = await recipient(r.recipientId);
      return x?.repliedAt ? x : null;
    },
    { label: "first reply" },
  );
  await postInbound(r.digits, { body: "two" });
  await new Promise((res) => setTimeout(res, 1200));
  const after = await recipient(r.recipientId);
  // Same timestamp — the metric is "recipients who replied", not messages.
  expect(after?.repliedAt?.getTime()).toBe(first.repliedAt?.getTime());
});

test("a template button tap records the STABLE option id, not the label", async () => {
  const r = await seedRecipient("click");
  expect(
    (await postInbound(r.digits, { button: { id: "buy_now", text: "Buy now" } })).status,
  ).toBe(200);

  const row = await pollUntil(
    async () => {
      const x = await recipient(r.recipientId);
      return x?.clickedAt ? x : null;
    },
    { label: "clickedAt set" },
  );
  // The id, never "Buy now" — titles are editable and would reset click history.
  expect(row.clickedOptionId).toBe("buy_now");
  // A button tap is also a reply.
  expect(row.repliedAt).not.toBeNull();
});

test("STOP opts the contact out of marketing and marks the campaign recipient", async () => {
  const r = await seedRecipient("stop");
  expect((await postInbound(r.digits, { body: "STOP" })).status).toBe(200);

  await pollUntil(
    async () => {
      const c = await db().contact.findUnique({
        where: { id: r.contactId },
        select: { marketingOptOutAt: true, marketingOptOutSource: true },
      });
      return c?.marketingOptOutAt ? c : null;
    },
    { label: "contact opted out" },
  );
  const c = await db().contact.findUnique({
    where: { id: r.contactId },
    select: { marketingOptOutSource: true },
  });
  expect(c?.marketingOptOutSource).toBe("stop_keyword");

  const row = await recipient(r.recipientId);
  expect(row?.optedOutAt).not.toBeNull(); // attributed to THIS campaign
});

test("cost: Meta's pricing object on a status webhook lands on the recipient", async () => {
  const r = await seedRecipient("cost");
  const res = await postMetaWebhook(META_TEST_TEAM_ID, {
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
                  id: r.wamid,
                  status: "sent",
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: r.digits,
                  pricing: { billable: true, pricing_model: "CBP", category: "marketing" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  expect(res.status).toBe(200);

  const row = await pollUntil(
    async () => {
      const x = await recipient(r.recipientId);
      return x?.pricingCategory ? x : null;
    },
    { label: "pricing captured" },
  );
  expect(row.pricingCategory).toBe("marketing");
  expect(row.pricingBillable).toBe(true);
});
