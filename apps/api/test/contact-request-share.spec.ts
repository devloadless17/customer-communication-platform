/**
 * REQUEST_CONTACT_INFO replies — the one proactive remedy for a BSUID-only
 * thread.
 *
 * The customer answers our "share contact info" button with THEIR OWN number
 * and Meta resolves it to a wa_id: the reply arrives as an ordinary inbound
 * `contacts` card with `origin: "contact_request"` + `phones[].wa_id`. That
 * resolution carries the same trust as the contact-share chip (self-asserted
 * through an explicit consent flow), so it may fill a NULL phone and drive
 * strong-key Customer adoption. Everything else about it is deliberately
 * conservative:
 *
 *   - a stored phone is NEVER overwritten (it is the vendor-verified channel
 *     identity — a shared card can't demote it);
 *   - a wa_id another contact already holds is NOT filled (the partial unique
 *     would reject it anyway) — the two are linked through one Customer;
 *   - a forwarded vCard (`origin: "other"` / absent) is display-only and must
 *     change NOTHING — someone else's number is not this contact's identity.
 *
 * Driven through the real chain (parseWebhook → ingestEvents) — the
 * enrichment is awaited post-commit, so every assertion here is deterministic.
 *
 *   pnpm --filter @ccp/api exec vitest run test/contact-request-share.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";

vi.mock("@/lib/events/bus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events/bus")>();
  return { ...actual, publish: vi.fn(async () => undefined) };
});

import { metaProvider } from "@/lib/providers/meta";
import { ingestWithRedelivery } from "./_ingest-redelivery";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `crs${Date.now().toString().slice(-8)}`;
const PN = `${S}_pn_a`;
/** A parseable Lebanese mobile (+961 71 XXX XXX) unique per suite run AND per
 *  call site — `getCountryFromPhone` must derive "LB" from it. */
const phoneFixture = (i: string) => `96171${S.replace(/\D/g, "").slice(-5)}${i}`;

let orgId = "";
let workspaceId = "";
let connA = "";
let wamidSeq = 0;

/** Inbound `contacts` card from a BSUID-identified sender. */
function contactsCardPayload(args: {
  senderBsuid: string;
  card: Record<string, unknown>;
}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: `${S}_waba_a`,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550001111", phone_number_id: PN },
              contacts: [
                { profile: { name: "Cold Customer" }, wa_id: "", user_id: args.senderBsuid },
              ],
              messages: [
                {
                  from: "",
                  from_user_id: args.senderBsuid,
                  id: `wamid.${S}_CR${++wamidSeq}`,
                  timestamp: "1785400000",
                  type: "contacts",
                  contacts: [args.card],
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function deliver(payload: unknown) {
  const events = metaProvider.parseWebhook(payload);
  expect(events.some((e) => e.kind === "message")).toBe(true);
  await ingestWithRedelivery(workspaceId, "whatsapp", events, connA);
}

async function seedBsuidContact(bsuid: string): Promise<string> {
  return (
    await prisma.contact.create({
      data: {
        workspaceId,
        name: "Cold Customer",
        identityChannel: "whatsapp",
        phoneNumber: null,
        bsuid,
      },
      select: { id: true },
    })
  ).id;
}

async function contactRow(id: string) {
  return prisma.contact.findUniqueOrThrow({
    where: { id },
    select: { phoneNumber: true, countryCode: true, customerId: true, bsuid: true },
  });
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `CR Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `CR WS ${S}`, organizationId: orgId } })
  ).id;
  connA = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: PN,
        isDefault: true,
        isActive: true,
        config: { phoneNumberId: PN, displayPhoneNumber: "+1 555-020-0001" },
        secrets: {},
        messagingHealthUpdatedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("contacts card with origin: contact_request", () => {
  it("fills a NULL phone + derives the country, and adopts the strong-key Customer", async () => {
    const waId = phoneFixture("1");
    // The same person already exists on a sibling channel under a Customer —
    // the strong key (exact phone) should fold the BSUID thread onto them.
    const person = await prisma.customer.create({
      data: { workspaceId, name: "Known Person" },
      select: { id: true },
    });
    await prisma.contact.create({
      data: {
        workspaceId,
        name: "Messenger side",
        identityChannel: "messenger",
        externalContactId: `${S}_psid_41`,
        phoneNumber: waId,
        customerId: person.id,
      },
    });

    const contactId = await seedBsuidContact("LB.CR41");
    await deliver(
      contactsCardPayload({
        senderBsuid: "LB.CR41",
        card: {
          name: { formatted_name: "Cold Customer" },
          phones: [{ phone: `+${waId}`, type: "CELL", wa_id: waId }],
          origin: "contact_request",
        },
      }),
    );

    const row = await contactRow(contactId);
    expect(row.phoneNumber).toBe(waId);
    // Phone-derived country (961… → LB), not profile-asserted.
    expect(row.countryCode).toBe("LB");
    expect(row.customerId).toBe(person.id);
  });

  it("NEVER overwrites an existing phone", async () => {
    const storedPhone = phoneFixture("2");
    const sharedWaId = phoneFixture("3");
    const contactId = (
      await prisma.contact.create({
        data: {
          workspaceId,
          name: "Warm Customer",
          identityChannel: "whatsapp",
          phoneNumber: storedPhone,
          bsuid: "LB.CR42",
        },
        select: { id: true },
      })
    ).id;

    await deliver(
      contactsCardPayload({
        senderBsuid: "LB.CR42",
        card: {
          name: { formatted_name: "Warm Customer" },
          phones: [{ phone: `+${sharedWaId}`, type: "CELL", wa_id: sharedWaId }],
          origin: "contact_request",
        },
      }),
    );

    const row = await contactRow(contactId);
    expect(row.phoneNumber).toBe(storedPhone);
  });

  it("links through the holder's Customer instead of filling a COLLIDING wa_id", async () => {
    const waId = phoneFixture("4");
    const holderCustomer = await prisma.customer.create({
      data: { workspaceId, name: "Holder person" },
      select: { id: true },
    });
    const holderId = (
      await prisma.contact.create({
        data: {
          workspaceId,
          name: "Holder",
          identityChannel: "whatsapp",
          phoneNumber: waId,
          customerId: holderCustomer.id,
        },
        select: { id: true },
      })
    ).id;
    const contactId = await seedBsuidContact("LB.CR44");

    await deliver(
      contactsCardPayload({
        senderBsuid: "LB.CR44",
        card: {
          name: { formatted_name: "Cold Customer" },
          phones: [{ phone: `+${waId}`, type: "CELL", wa_id: waId }],
          origin: "contact_request",
        },
      }),
    );

    const row = await contactRow(contactId);
    // The holder owns the wa_id key — no fill (the partial unique would
    // reject it anyway)…
    expect(row.phoneNumber).toBeNull();
    // …but both now resolve to the same person.
    expect(row.customerId).toBe(holderCustomer.id);
    expect((await contactRow(holderId)).customerId).toBe(holderCustomer.id);
  });

  it("a forwarded vCard (origin: other) changes NOTHING", async () => {
    const waId = phoneFixture("5");
    const contactId = await seedBsuidContact("LB.CR45");

    await deliver(
      contactsCardPayload({
        senderBsuid: "LB.CR45",
        card: {
          name: { formatted_name: "Someone Else" },
          phones: [{ phone: `+${waId}`, type: "CELL", wa_id: waId }],
          origin: "other",
        },
      }),
    );

    const row = await contactRow(contactId);
    expect(row.phoneNumber).toBeNull();
    expect(row.customerId).toBeNull();

    // Absent origin (the pre-rollout wire) is just as inert.
    await deliver(
      contactsCardPayload({
        senderBsuid: "LB.CR45",
        card: {
          name: { formatted_name: "Someone Else" },
          phones: [{ phone: `+${waId}`, type: "CELL", wa_id: waId }],
        },
      }),
    );
    expect((await contactRow(contactId)).phoneNumber).toBeNull();
  });

  it("the card still renders — the structured payload persists on the message", async () => {
    // The identity enrichment must never eat the card itself: the message row
    // keeps the vCard for the bubble, whatever the origin decided.
    const waId = phoneFixture("6");
    await seedBsuidContact("LB.CR46");
    await deliver(
      contactsCardPayload({
        senderBsuid: "LB.CR46",
        card: {
          name: { formatted_name: "Cold Customer" },
          phones: [{ phone: `+${waId}`, type: "CELL", wa_id: waId }],
          origin: "contact_request",
        },
      }),
    );
    const msg = await prisma.message.findFirstOrThrow({
      where: { workspaceId, externalId: `wamid.${S}_CR${wamidSeq}` },
      select: { body: true, structured: true },
    });
    expect(msg.body).toContain("Contact card");
    const structured = msg.structured as { kind?: string; contacts?: Array<{ origin?: string; waIds?: string[] }> };
    expect(structured?.kind).toBe("contacts");
    expect(structured?.contacts?.[0]?.origin).toBe("contact_request");
    expect(structured?.contacts?.[0]?.waIds).toEqual([waId]);
  });
});
