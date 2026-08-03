/**
 * A value typed into the widget's public pre-chat box is STORED, but it never
 * acts as a strong key — in EITHER direction.
 *
 * CLAUDE.md §6 states the rule that way ("excluded from the strong-key
 * candidate set in both directions"), because a strong key is only strong when
 * a vendor verified the identity behind it, and a website visitor is anonymous.
 * Only the candidate half was implemented: the resolver excluded ephemeral
 * contacts from the rows it SEARCHED, but happily used an ephemeral contact's
 * own typed phone as the key to search WITH.
 *
 * That reversed direction is the same attack from the other side. A stranger
 * opens the widget and types a known customer's phone number into pre-chat.
 * Their widget contact is created, the resolver takes that typed number as a
 * strong key, finds the real WhatsApp contact that owns it, and adopts that
 * person's Customer — folding the stranger's live thread into the real owner's
 * unified profile and linked-channels switcher, where an agent reads it as one
 * person.
 *
 * These tests run against the real resolver and a real database, so they fail
 * if the guard is removed on either side.
 */
import { existsSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { findExistingCustomerIdByStrongKey } from "@/lib/identity/identity-service";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
// The resolver defaults its client to the shared Nest `db`, which no bare spec
// boots — pass this connection explicitly, exactly as ingest passes its `tx`.
const client = prisma as unknown as Parameters<typeof findExistingCustomerIdByStrongKey>[2];

const PHONE = "96170123456";

let orgId = "";
let workspaceId = "";
let realCustomerId = "";
let realContactId = "";

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `EPH Org ${Date.now()}` } })).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `EPH WS ${Date.now()}`, organizationId: orgId } })
  ).id;

  // The real, vendor-verified person: a WhatsApp contact already linked to a
  // Customer. This is the profile the guard has to protect.
  realCustomerId = (await prisma.customer.create({ data: { workspaceId, name: "Real Owner" } })).id;
  realContactId = (
    await prisma.contact.create({
      data: {
        workspaceId,
        name: "Real Owner",
        identityChannel: "whatsapp",
        phoneNumber: PHONE,
        customerId: realCustomerId,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("ephemeral contacts and strong keys", () => {
  it("a WIDGET contact's typed phone does NOT adopt the real person's Customer", async () => {
    const adopted = await findExistingCustomerIdByStrongKey(workspaceId, {
      name: "Anonymous Visitor",
      phoneNumber: PHONE,
      email: null,
      identityChannel: "webchatwidget",
    }, client);
    expect(adopted).toBeNull();
  });

  it("a real channel's phone still adopts — the guard is narrow, not a blanket off-switch", async () => {
    // Same number, arriving on a channel where the vendor verified it. This is
    // the cross-channel merge §6 exists to perform, and it must keep working.
    const adopted = await findExistingCustomerIdByStrongKey(workspaceId, {
      name: "Real Owner",
      phoneNumber: PHONE,
      email: null,
      identityChannel: "messenger",
    }, client);
    expect(adopted).toBe(realCustomerId);
  });

  it("an omitted identityChannel still adopts — absent means 'not known to be ephemeral'", async () => {
    // Several callers resolve before a contact row exists. The default has to
    // stay permissive, or every one of them would silently stop merging.
    const adopted = await findExistingCustomerIdByStrongKey(workspaceId, {
      name: "Real Owner",
      phoneNumber: PHONE,
      email: null,
    }, client);
    expect(adopted).toBe(realCustomerId);
  });

  it("the CANDIDATE half still holds: a widget contact is never adopted FROM", async () => {
    // The original direction. A widget contact carrying a typed phone, already
    // linked to its own Customer, must not be found as a match for a real
    // contact arriving with that number.
    const widgetCustomerId = (
      await prisma.customer.create({ data: { workspaceId, name: "Visitor" } })
    ).id;
    await prisma.contact.create({
      data: {
        workspaceId,
        name: "Visitor",
        identityChannel: "webchatwidget",
        externalContactId: `vis_${Date.now()}`,
        phoneNumber: "96179999999",
        customerId: widgetCustomerId,
      },
    });

    const adopted = await findExistingCustomerIdByStrongKey(workspaceId, {
      name: "Someone Real",
      phoneNumber: "96179999999",
      email: null,
      identityChannel: "whatsapp",
    }, client);
    expect(adopted).toBeNull();
  });

  it("the real contact is untouched — the guard refuses a merge, it never rewrites rows", async () => {
    const row = await prisma.contact.findUnique({
      where: { id: realContactId },
      select: { customerId: true, phoneNumber: true },
    });
    expect(row?.customerId).toBe(realCustomerId);
    expect(row?.phoneNumber).toBe(PHONE);
  });
});
