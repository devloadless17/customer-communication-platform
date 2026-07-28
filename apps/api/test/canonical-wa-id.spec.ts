/**
 * Canonical wa_id reconciliation (service-messages doc: "For Brazil and
 * Mexico, the extra added prefix of the phone number may be modified by the
 * Cloud API").
 *
 * Meta's status webhook reports the wa_id it ACTUALLY delivered to
 * (`statuses[].recipient_id`). When that differs from the number we dialed —
 * a CSV-imported Brazilian number with the mobile "9", say — the customer's
 * reply arrives FROM the wa_id and would fork a duplicate contact + thread.
 * `reconcileCanonicalWaId` closes that fork ahead of time:
 *
 *   - nobody holds the wa_id      → re-key the contact's phone to it
 *   - another contact holds it    → link the two through one Customer
 *                                    (adopt an existing one, or mint one)
 *   - both have DIFFERENT customers → stand down (manual-merge territory —
 *                                    the auto-fold bug class two audits hit)
 *   - junk / equal / non-WhatsApp → no-op
 *
 *   pnpm --filter @ccp/api exec vitest run test/canonical-wa-id.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { reconcileCanonicalWaId } from "@/lib/identity/canonical-wa-id";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
setSharedDb(prisma as unknown as PrismaClient);

const S = Date.now().toString().slice(-7);

let orgId = "";
let workspaceId = "";

async function makeContact(
  phone: string,
  extra: { customerId?: string; identityChannel?: "whatsapp" | "messenger" } = {},
): Promise<string> {
  const row = await prisma.contact.create({
    data: {
      workspaceId,
      name: `WA ${phone}`,
      identityChannel: extra.identityChannel ?? "whatsapp",
      ...(extra.identityChannel === "messenger"
        ? { externalContactId: `psid_${phone}` }
        : {}),
      phoneNumber: phone,
      ...(extra.customerId ? { customerId: extra.customerId } : {}),
    },
    select: { id: true },
  });
  return row.id;
}

async function contactRow(id: string) {
  return prisma.contact.findUnique({
    where: { id },
    select: { phoneNumber: true, customerId: true, version: true },
  });
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `WaId Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `WaId WS ${S}`, organizationId: orgId } })
  ).id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("reconcileCanonicalWaId", () => {
  it("re-keys the contact when nobody holds the wa_id (the common BR/MX case)", async () => {
    // Dialed with Brazil's mobile 9; Meta delivered to the 9-less wa_id.
    const dialed = `55119${S}1`;
    const waId = `5511${S}1`;
    const id = await makeContact(dialed);

    await reconcileCanonicalWaId(workspaceId, id, waId);

    const row = await contactRow(id);
    expect(row?.phoneNumber).toBe(waId);
    expect(row?.version).toBe(1); // CAS token bumped like any contact edit
  });

  it("links through the holder's EXISTING customer instead of re-keying on collision", async () => {
    const waId = `5511${S}2`;
    const customer = await prisma.customer.create({
      data: { workspaceId, name: "Holder person" },
      select: { id: true },
    });
    const holder = await makeContact(waId, { customerId: customer.id });
    const imported = await makeContact(`55119${S}2`);

    await reconcileCanonicalWaId(workspaceId, imported, waId);

    const row = await contactRow(imported);
    // Phone untouched (the holder owns the wa_id key)…
    expect(row?.phoneNumber).toBe(`55119${S}2`);
    // …but both now resolve to the same person.
    expect(row?.customerId).toBe(customer.id);
    expect((await contactRow(holder))?.customerId).toBe(customer.id);
  });

  it("mints ONE customer for both when neither side has one", async () => {
    const waId = `5511${S}3`;
    const holder = await makeContact(waId);
    const imported = await makeContact(`55119${S}3`);

    await reconcileCanonicalWaId(workspaceId, imported, waId);

    const a = await contactRow(imported);
    const b = await contactRow(holder);
    expect(a?.customerId).toBeTruthy();
    expect(a?.customerId).toBe(b?.customerId);
  });

  it("stands down when the two sides belong to DIFFERENT customers", async () => {
    const waId = `5511${S}4`;
    const custA = await prisma.customer.create({
      data: { workspaceId, name: "A" },
      select: { id: true },
    });
    const custB = await prisma.customer.create({
      data: { workspaceId, name: "B" },
      select: { id: true },
    });
    const holder = await makeContact(waId, { customerId: custA.id });
    const imported = await makeContact(`55119${S}4`, { customerId: custB.id });

    await reconcileCanonicalWaId(workspaceId, imported, waId);

    // Nothing moved — folding established profiles is a human decision.
    expect((await contactRow(imported))?.customerId).toBe(custB.id);
    expect((await contactRow(holder))?.customerId).toBe(custA.id);
    expect((await contactRow(imported))?.phoneNumber).toBe(`55119${S}4`);
  });

  it("no-ops on equal digits, junk wa_ids, and non-WhatsApp contacts", async () => {
    const phone = `961${S}5`;
    const id = await makeContact(phone);
    await reconcileCanonicalWaId(workspaceId, id, phone); // equal
    await reconcileCanonicalWaId(workspaceId, id, "12"); // too short
    await reconcileCanonicalWaId(workspaceId, id, "not-a-number"); // junk
    const row = await contactRow(id);
    expect(row?.phoneNumber).toBe(phone);
    expect(row?.version).toBe(0);

    // A messenger contact never re-keys, whatever the caller passes.
    const social = await makeContact(`961${S}6`, { identityChannel: "messenger" });
    await reconcileCanonicalWaId(workspaceId, social, `5511${S}6`);
    expect((await contactRow(social))?.phoneNumber).toBe(`961${S}6`);
  });

  it("is scoped to the workspace — a foreign contact id is untouchable", async () => {
    const otherWs = await prisma.workspace.create({
      data: { name: `WaId WS2 ${S}`, organizationId: orgId },
      select: { id: true },
    });
    const foreign = await prisma.contact.create({
      data: {
        workspaceId: otherWs.id,
        name: "Foreign",
        identityChannel: "whatsapp",
        phoneNumber: `55119${S}7`,
      },
      select: { id: true },
    });

    await reconcileCanonicalWaId(workspaceId, foreign.id, `5511${S}7`);

    const row = await prisma.contact.findUnique({
      where: { id: foreign.id },
      select: { phoneNumber: true },
    });
    expect(row?.phoneNumber).toBe(`55119${S}7`);
    await prisma.workspace.deleteMany({ where: { id: otherWs.id } });
  });
});
