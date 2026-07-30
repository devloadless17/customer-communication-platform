/**
 * NAMED-format template broadcasts, proven at the WIRE.
 *
 * Meta templates come in two parameter formats. A POSITIONAL one (`{{1}}`)
 * takes bare `{ text }` parameters; a NAMED one (`{{order_id}}`) takes
 * `{ parameter_name, text }`. Send the wrong shape and Meta rejects EVERY
 * recipient with error 132000 — a whole campaign lost, billed nothing but
 * costing the number's quality rating.
 *
 * Broadcasts used to refuse named templates outright. They now send them, so
 * the thing worth pinning is not "the broadcast completed" but the exact JSON
 * that reached Meta:
 *
 *   1. a NAMED template sends `parameter_name` alongside each value, zipped to
 *      the placeholder names in FIRST-APPEARANCE order (the order the composer
 *      collects them in — a mismatch silently swaps the customer's values),
 *   2. a POSITIONAL template still sends bare `{ text }` and NO parameter_name,
 *   3. the format comes from Meta's stored `parameter_format`, not from a regex
 *      over the body — so a positional template containing `{{order_id}}` as
 *      literal copy is still sent positionally.
 *
 * (3) is the reason the column exists, and it is invisible to any test that
 * only checks a well-behaved template.
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

const S = `bnt${Date.now().toString().slice(-8)}`;

/** Everything this spec created, torn down so the shared team keeps its shape. */
const createdContactIds: string[] = [];
const createdBroadcastIds: string[] = [];
const createdTemplateIds: string[] = [];

test.afterAll(async () => {
  // This team is SHARED and other specs reuse its contacts. Leaving ours behind
  // changed what they picked up — clean up rather than widening their queries.
  await db().broadcastRecipient.deleteMany({
    where: { broadcastId: { in: createdBroadcastIds } },
  });
  await db().broadcast.deleteMany({ where: { id: { in: createdBroadcastIds } } });
  await db().message.deleteMany({ where: { conversation: { contactId: { in: createdContactIds } } } });
  await db().conversation.deleteMany({ where: { contactId: { in: createdContactIds } } });
  await db().contact.deleteMany({ where: { id: { in: createdContactIds } } });
  await db().messageTemplate.deleteMany({ where: { id: { in: createdTemplateIds } } });
});

test.beforeAll(async () => {
  // The runner is driven IN-PROCESS here rather than through an HTTP route:
  // what this spec asserts is the wire shape the runner builds, and calling it
  // directly removes the api process from the equation entirely. It posts to
  // the mock Graph via META_GRAPH_BASE_URL, same as the api would.
  setSharedDb(db() as never);
  // Convention (reactions.spec.ts): seed, never wipe mid-run — a wipe stales
  // the api's 60s provider-config cache and breaks every later spec.
  await seedMetaTestTeam();
});

/** A template row as a real sync would have written it. */
async function makeTemplate(opts: {
  name: string;
  bodyText: string;
  parameterFormat: "named" | "positional";
}) {
  return db().messageTemplate.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      // The WABA row is seeded by `seedMetaTestTeam`; look up its FK rather than
      // a nested connect, which Prisma rejects on an unchecked create input.
      wabaAccountId: (
        await db().whatsappBusinessAccount.findUniqueOrThrow({
          where: { externalWabaId: WA_WABA_ID },
          select: { id: true },
        })
      ).id,
      externalId: `tpl_${opts.name}`,
      name: opts.name,
      language: "en_US",
      category: "marketing",
      status: "approved",
      bodyText: opts.bodyText,
      components: [{ type: "BODY", text: opts.bodyText }],
      parameterFormat: opts.parameterFormat,
    },
    select: { id: true },
  });
}

async function makeContact(suffix: string) {
  return db().contact.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      name: `BNT ${suffix}`,
      phoneNumber: `+9612${S}${suffix}`,
      identityChannel: "whatsapp",
      // An OPEN 24h window. Sibling specs in this shared team reuse "whatever
      // contacts exist", and a contact with no inbound fails their freeform
      // sends with `window_closed` — a fixture-shape leak, not a real bug.
      lastInboundAt: new Date(),
    },
    select: { id: true },
  });
}

/** Fire a broadcast at ONE contact and wait for it to finish. */
async function runBroadcast(templateId: string, contactId: string, body: string[]) {
  const broadcast = await db().broadcast.create({
    data: {
      workspaceId: META_TEST_TEAM_ID,
      channel: "whatsapp",
      kind: "template",
      status: "queued",
      templateId,
      templateName: (await db().messageTemplate.findUniqueOrThrow({
        where: { id: templateId },
        select: { name: true },
      })).name,
      templateLanguage: "en_US",
      templateCategory: "marketing",
      variables: { body },
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

test("a NAMED template sends parameter_name for every value, in placeholder order", async () => {
  await resetMock();
  const template = await makeTemplate({
    name: `named_${S}`,
    // Deliberately NOT alphabetical: `order_id` appears first, `city` second.
    // A runner that sorted the names instead of preserving first-appearance
    // order would swap the customer's values and pass a naive assertion.
    bodyText: "Hi, order {{order_id}} ships to {{city}}.",
    parameterFormat: "named",
  });
  const contact = await makeContact("01");
  createdContactIds.push(contact.id);
  createdTemplateIds.push(template.id);

  await runBroadcast(template.id, contact.id, ["A-1001", "Beirut"]);

  const sends = await mockSends();
  expect(sends.length).toBeGreaterThan(0);
  const body = sends[sends.length - 1]!.body;
  const params = body.template.components.find(
    (c: { type: string }) => c.type === "body",
  ).parameters;

  expect(params).toEqual([
    { type: "text", parameter_name: "order_id", text: "A-1001" },
    { type: "text", parameter_name: "city", text: "Beirut" },
  ]);
});

test("a POSITIONAL template still sends bare parameters, with no parameter_name", async () => {
  await resetMock();
  const template = await makeTemplate({
    name: `positional_${S}`,
    bodyText: "Hi {{1}}, your order {{2}} shipped.",
    parameterFormat: "positional",
  });
  const contact = await makeContact("02");
  createdContactIds.push(contact.id);
  createdTemplateIds.push(template.id);

  await runBroadcast(template.id, contact.id, ["Layla", "A-1002"]);

  const sends = await mockSends();
  const body = sends[sends.length - 1]!.body;
  const params = body.template.components.find(
    (c: { type: string }) => c.type === "body",
  ).parameters;

  expect(params).toEqual([
    { type: "text", text: "Layla" },
    { type: "text", text: "A-1002" },
  ]);
  for (const p of params) expect(p.parameter_name).toBeUndefined();
});

test("the STORED format wins over what the body text looks like", async () => {
  await resetMock();
  const template = await makeTemplate({
    name: `literal_${S}`,
    // This body contains `{{order_id}}` as LITERAL COPY — the customer really
    // is told to quote that string. A regex-based inference would call this
    // template named, send `parameter_name`, and fail every recipient. Meta
    // says it is positional, and Meta is the authority.
    bodyText: "Hi {{1}}, quote {{order_id}} when you reply.",
    parameterFormat: "positional",
  });
  const contact = await makeContact("03");
  createdContactIds.push(contact.id);
  createdTemplateIds.push(template.id);

  await runBroadcast(template.id, contact.id, ["Layla"]);

  const sends = await mockSends();
  const body = sends[sends.length - 1]!.body;
  const params = body.template.components.find(
    (c: { type: string }) => c.type === "body",
  ).parameters;

  expect(params).toEqual([{ type: "text", text: "Layla" }]);
});
