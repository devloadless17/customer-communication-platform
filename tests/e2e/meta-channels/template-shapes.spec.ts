/**
 * The template shapes added for Meta's marketing/utility category docs, proven
 * at the WIRE.
 *
 * Unit tests already pin `buildTemplateSendComponents` against Meta's published
 * examples. What they cannot prove is that a value SURVIVES the whole path —
 * Zod schema → service guard → runner → provider → JSON on the socket. Every
 * defect this session lived in that gap rather than in the builder: a field the
 * schema didn't accept, a guard that rejected a legal send, a value the
 * broadcast path couldn't carry at all.
 *
 * So each case here drives a real broadcast at the real runner and asserts the
 * exact JSON the mock Graph received.
 *
 *   pnpm test:e2e:meta -- template-shapes
 */

import { test, expect } from "@playwright/test";

import { setSharedDb } from "../../../apps/api/src/lib/db";
import { startBroadcast } from "../../../apps/api/src/lib/broadcast-runner";
import { db, pollUntil } from "../_helpers/db";
import {
  seedMetaTestTeam,
  resetMock,
  mockSends,
  META_TEST_TEAM_ID,
  WA_WABA_ID,
} from "../_helpers/meta";

test.describe.configure({ mode: "serial" });

const S = `tsh${Date.now().toString().slice(-8)}`;

const createdContactIds: string[] = [];
const createdBroadcastIds: string[] = [];
const createdTemplateIds: string[] = [];

test.afterAll(async () => {
  // The team is SHARED with every other spec — leave it exactly as found.
  await db().broadcastRecipient.deleteMany({
    where: { broadcastId: { in: createdBroadcastIds } },
  });
  await db().broadcast.deleteMany({ where: { id: { in: createdBroadcastIds } } });
  await db().message.deleteMany({
    where: { conversation: { contactId: { in: createdContactIds } } },
  });
  await db().conversation.deleteMany({ where: { contactId: { in: createdContactIds } } });
  await db().contact.deleteMany({ where: { id: { in: createdContactIds } } });
  await db().messageTemplate.deleteMany({ where: { id: { in: createdTemplateIds } } });
});

test.beforeAll(async () => {
  setSharedDb(db() as never);
  // Seed, never wipe: a mid-run wipe stales the api's 60s provider-config cache
  // and silently breaks every later spec.
  await seedMetaTestTeam();
});

async function makeTemplate(name: string, components: unknown[], bodyText: string) {
  const row = await db().messageTemplate.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      wabaId: WA_WABA_ID,
      externalId: `tpl_${name}`,
      name,
      language: "en_US",
      category: "marketing",
      status: "approved",
      bodyText,
      components: components as never,
      parameterFormat: "positional",
    },
    select: { id: true, name: true },
  });
  createdTemplateIds.push(row.id);
  return row;
}

async function makeContact(suffix: string) {
  const row = await db().contact.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      name: `TSH ${suffix}`,
      phoneNumber: `+9613${S}${suffix}`,
      identityChannel: "whatsapp",
      // Open 24h window — sibling specs reuse "whatever contacts exist" and a
      // window-less contact fails their freeform sends.
      lastInboundAt: new Date(),
    },
    select: { id: true },
  });
  createdContactIds.push(row.id);
  return row;
}

/** Fire a one-recipient broadcast and wait for it to settle. */
async function runBroadcast(
  template: { id: string; name: string },
  contactId: string,
  variables: Record<string, unknown>,
) {
  const broadcast = await db().broadcast.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      channel: "whatsapp",
      kind: "template",
      status: "queued",
      templateId: template.id,
      templateName: template.name,
      templateLanguage: "en_US",
      templateCategory: "marketing",
      variables: variables as never,
      audienceMode: "contacts",
      totalCount: 1,
    },
    select: { id: true },
  });
  createdBroadcastIds.push(broadcast.id);
  await db().broadcastRecipient.create({
    data: { broadcastId: broadcast.id, contactId, status: "queued" },
  });

  await startBroadcast(broadcast.id);
  await pollUntil(
    async () => {
      const row = await db().broadcast.findUniqueOrThrow({
        where: { id: broadcast.id },
        select: { status: true },
      });
      return row.status === "completed" || row.status === "failed" ? row.status : null;
    },
    { timeoutMs: 25_000, label: `broadcast ${broadcast.id} settled` },
  );
  return broadcast.id;
}

/** The components of the single template send the mock just received. */
async function sentComponents(): Promise<any[]> {
  const sends = await mockSends();
  expect(sends.length).toBe(1);
  return sends[0]!.body?.template?.components ?? [];
}

test("a limited-time offer carries its expiry in MILLISECONDS", async () => {
  // The unit trap this guards: `/compare` and `template_analytics` next door
  // both take SECONDS. Handing this field seconds doesn't error — it renders a
  // countdown that expired in 1970 — so the unit has to survive the whole path.
  await resetMock();
  const template = await makeTemplate(
    `lto_${S}`,
    [
      { type: "BODY", text: "Rest and relax with {{1}} off!" },
      {
        type: "LIMITED_TIME_OFFER",
        limited_time_offer: { text: "Expiring offer!", has_expiration: true },
      },
    ],
    "Rest and relax with {{1}} off!",
  );
  const contact = await makeContact("1");
  const expiresAt = Date.now() + 3 * 86_400_000;

  await runBroadcast(template, contact.id, {
    body: ["25%"],
    limitedTimeOfferExpiresAtMs: expiresAt,
  });

  const components = await sentComponents();
  const offer = components.find((c) => c.type === "limited_time_offer");
  expect(offer).toBeTruthy();
  expect(offer.parameters[0].limited_time_offer.expiration_time_ms).toBe(expiresAt);
  // Ordering is part of the contract: Meta's example puts the offer AFTER the
  // body and before any buttons.
  expect(components.findIndex((c) => c.type === "body")).toBeLessThan(
    components.findIndex((c) => c.type === "limited_time_offer"),
  );
});

test("a carousel indexes buttons WITHIN each card, not across the message", async () => {
  // Numbering them message-wide returns "Parameter value for URL was expected
  // but was not found" — Meta matches a button by position inside its card.
  await resetMock();
  const card = {
    components: [
      { type: "HEADER", format: "IMAGE", example: { header_handle: ["4::an"] } },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "More like this" },
          { type: "URL", text: "Shop", url: "https://x.test/{{1}}", example: ["a"] },
        ],
      },
    ],
  };
  const template = await makeTemplate(
    `carousel_${S}`,
    [
      { type: "BODY", text: "Rare succulents, {{1}} off!" },
      { type: "CAROUSEL", cards: [card, card] },
    ],
    "Rare succulents, {{1}} off!",
  );
  const contact = await makeContact("2");

  await runBroadcast(template, contact.id, {
    body: ["30%"],
    cards: [
      {
        kind: "image",
        link: "https://cdn.test/a.jpg",
        buttons: [
          { index: 0, subType: "quick_reply", text: "more-aloes" },
          { index: 1, subType: "url", text: "blue-elf" },
        ],
      },
      {
        kind: "image",
        link: "https://cdn.test/b.jpg",
        buttons: [
          { index: 0, subType: "quick_reply", text: "more-crassulas" },
          { index: 1, subType: "url", text: "buddhas-temple" },
        ],
      },
    ],
  });

  const carousel = (await sentComponents()).find((c) => c.type === "carousel");
  expect(carousel).toBeTruthy();
  expect(carousel.cards.map((c: any) => c.card_index)).toEqual([0, 1]);
  // The assertion that matters: card 2's first button is index "0" AGAIN.
  for (const c of carousel.cards) {
    const buttons = c.components.filter((x: any) => x.type === "button");
    expect(buttons.map((b: any) => b.index)).toEqual(["0", "1"]);
    expect(buttons[0].parameters[0].type).toBe("payload");
    expect(buttons[1].parameters[0].type).toBe("text");
  }
  // Each card carries its own media, in card order.
  expect(
    carousel.cards.map((c: any) => c.components[0].parameters[0].image.link),
  ).toEqual(["https://cdn.test/a.jpg", "https://cdn.test/b.jpg"]);
});

test("a LOCATION header ships the pin, omitting the optional labels", async () => {
  // A location template is a marketing/utility shape whose pin is supplied per
  // SEND. The broadcast path could not carry one at all until recently, so
  // every recipient of a store-opening campaign would have failed at Meta.
  await resetMock();
  const template = await makeTemplate(
    `loc_${S}`,
    [
      { type: "HEADER", format: "LOCATION" },
      { type: "BODY", text: "We are opening near you, {{1}}!" },
    ],
    "We are opening near you, {{1}}!",
  );
  const contact = await makeContact("3");

  await runBroadcast(template, contact.id, {
    body: ["Lisa"],
    headerLocation: {
      latitude: "34.01881798498779",
      longitude: "-118.46708679200001",
      name: "",
      address: "",
    },
  });

  const header = (await sentComponents()).find((c) => c.type === "header");
  expect(header.parameters[0].type).toBe("location");
  // Blank labels are OMITTED, not sent as empty strings — Meta renders an empty
  // caption on the map card for those.
  expect(header.parameters[0].location).toEqual({
    latitude: "34.01881798498779",
    longitude: "-118.46708679200001",
  });
});

test("a paused template halts the campaigns that depend on it", async () => {
  // Meta's instruction, and the reason this runs off the STATUS webhook rather
  // than off send failures: the reactive breaker needs N failed sends first and
  // never fires at all for a campaign that hasn't started.
  const { pauseBroadcastsForTemplate, resumeBroadcastsForTemplate } = await import(
    "../../../apps/api/src/lib/broadcast-runner"
  );
  const template = await makeTemplate(
    `pause_${S}`,
    [{ type: "BODY", text: "Hi {{1}}" }],
    "Hi {{1}}",
  );
  const contact = await makeContact("4");
  const broadcast = await db().broadcast.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      channel: "whatsapp",
      kind: "template",
      // `scheduled` is the case the send-failure breaker can never catch: it
      // would fire LATER into a template that cannot send.
      status: "scheduled",
      templateId: template.id,
      templateName: template.name,
      templateLanguage: "en_US",
      variables: { body: ["x"] },
      audienceMode: "contacts",
      totalCount: 1,
    },
    select: { id: true },
  });
  createdBroadcastIds.push(broadcast.id);
  await db().broadcastRecipient.create({
    data: { broadcastId: broadcast.id, contactId: contact.id, status: "queued" },
  });

  await pauseBroadcastsForTemplate(META_TEST_TEAM_ID, template.id, "paused at Meta");
  let row = await db().broadcast.findUniqueOrThrow({
    where: { id: broadcast.id },
    select: { status: true, pausedReason: true },
  });
  expect(row.status).toBe("paused");
  // The reason the periodic auto-resume sweep skips — these wait for the
  // template's approval, not a blind cooldown retry.
  expect(row.pausedReason).toBe("template");

  await resumeBroadcastsForTemplate(META_TEST_TEAM_ID, template.id);
  row = await db().broadcast.findUniqueOrThrow({
    where: { id: broadcast.id },
    select: { status: true, pausedReason: true },
  });
  expect(row.status).not.toBe("paused");
});
