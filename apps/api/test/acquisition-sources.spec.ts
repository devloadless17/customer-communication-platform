/**
 * Acquisition sources — where customers came from, as counted.
 *
 * Real database on purpose: every claim in this report is a SQL claim (whose
 * first message counts, who belongs in `organic`, what a channel filter
 * narrows), and the defect pinned below survived typecheck and a live smoke
 * run because the dev database happened to hold no webchat visitors.
 *
 * The pinned regression: `organic` counted EVERY contact with no attributed
 * inbound — including ephemeral webchat visitors (`vis_<uuid>` sessions with
 * no phone or email), which are hidden from the contacts list, CSV and
 * audience counts by `DIRECTORY_CONTACT_SQL`. So the panel could read "All 40
 * contacts arrived directly" while the contacts page showed 12: N anonymous
 * chat sessions reported as N organically-acquired customers.
 *
 *   pnpm --filter @ccp/api exec vitest run test/acquisition-sources.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import {
  acquisitionSources,
  contactAcquisition,
} from "@/lib/analytics/acquisition-sources";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `aq${Date.now().toString().slice(-8)}`;

let orgId = "";
let workspaceId = "";
let adContact = "";

/** A contact + its conversation, one call. */
async function contactWithThread(data: {
  channel: "whatsapp" | "messenger" | "webchatwidget";
  phoneNumber?: string;
  externalContactId?: string;
  email?: string;
}): Promise<{ contactId: string; conversationId: string }> {
  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: `AQ ${data.externalContactId ?? data.phoneNumber}`,
      identityChannel: data.channel,
      phoneNumber: data.phoneNumber ?? null,
      externalContactId: data.externalContactId ?? null,
      email: data.email ?? null,
    },
    select: { id: true },
  });
  const conv = await prisma.conversation.create({
    data: { workspaceId, contactId: contact.id, channel: data.channel },
    select: { id: true },
  });
  return { contactId: contact.id, conversationId: conv.id };
}

async function inbound(
  conversationId: string,
  channel: "whatsapp" | "messenger" | "webchatwidget",
  opts: { attribution?: Record<string, unknown>; at: Date },
): Promise<void> {
  await prisma.message.create({
    data: {
      workspaceId,
      conversationId,
      channel,
      direction: "in",
      externalId: `${S}_${Math.abs(Math.trunc(opts.at.getTime()))}_${conversationId.slice(-6)}`,
      body: "hi",
      timestamp: opts.at,
      ...(opts.attribution ? { attribution: opts.attribution } : {}),
    },
  });
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `AQ Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `AQ WS ${S}`, organizationId: orgId } })
  ).id;

  // 1. WhatsApp contact acquired by an ad. A LATER attributed message names a
  //    different ad — the FIRST one must keep the credit.
  const ad = await contactWithThread({ channel: "whatsapp", phoneNumber: `96${S}01` });
  adContact = ad.contactId;
  await inbound(ad.conversationId, "whatsapp", {
    at: new Date("2026-03-01T10:00:00Z"),
    attribution: { source: "ad", adId: "AD_FIRST", headline: "Spring sale" },
  });
  await inbound(ad.conversationId, "whatsapp", {
    at: new Date("2026-06-01T10:00:00Z"),
    attribution: { source: "ad", adId: "AD_LATER" },
  });

  // 2. Organic WhatsApp contact — a real directory entry, no attribution.
  const organic = await contactWithThread({ channel: "whatsapp", phoneNumber: `96${S}02` });
  await inbound(organic.conversationId, "whatsapp", { at: new Date("2026-03-02T10:00:00Z") });

  // 3. Organic Messenger contact — exists to prove the channel filter narrows.
  const social = await contactWithThread({ channel: "messenger", externalContactId: `${S}_psid` });
  await inbound(social.conversationId, "messenger", { at: new Date("2026-03-03T10:00:00Z") });

  // 4. ANONYMOUS webchat visitor — an ephemeral chat session, not a directory
  //    entry. The regression: this row used to be counted as organic.
  const visitor = await contactWithThread({
    channel: "webchatwidget",
    externalContactId: `vis_${S}`,
  });
  await inbound(visitor.conversationId, "webchatwidget", { at: new Date("2026-03-04T10:00:00Z") });

  // 5. PROMOTED visitor — self-identified with an email, so directory
  //    membership is derived and they count like any other contact.
  const promoted = await contactWithThread({
    channel: "webchatwidget",
    externalContactId: `vis_${S}_p`,
    email: `aq-${S}@example.test`,
  });
  await inbound(promoted.conversationId, "webchatwidget", { at: new Date("2026-03-05T10:00:00Z") });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("aggregate report", () => {
  it("credits the FIRST attributed inbound, not a later one", async () => {
    const r = await acquisitionSources(workspaceId);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      source: "ad",
      sourceId: "AD_FIRST",
      headline: "Spring sale",
      contacts: 1,
    });
  });

  it("counts organic from DIRECTORY contacts only", async () => {
    const r = await acquisitionSources(workspaceId);
    // WhatsApp organic + Messenger organic + the PROMOTED visitor = 3.
    // The anonymous visitor is a chat session, not an acquired customer —
    // counting it made this panel disagree with the contacts page total.
    expect(r.organic).toBe(3);
  });

  it("narrows organic by the same channel filter as the rows", async () => {
    const r = await acquisitionSources(workspaceId, { channel: "messenger" });
    expect(r.rows).toHaveLength(0); // the ad contact is whatsapp
    expect(r.organic).toBe(1); // ONLY the messenger contact
  });

  it("bounds organic by the same window as the rows", async () => {
    // The rows count contacts ACQUIRED in the window; organic used to count
    // every directory contact with no attributed inbound EVER, so a windowed
    // report answered two different questions and overstated organic (and the
    // share percentages with it). These contacts entered the directory today,
    // so a window that closed in April holds no arrivals.
    const r = await acquisitionSources(workspaceId, {
      since: new Date("2026-03-01T00:00:00Z"),
      until: new Date("2026-04-01T00:00:00Z"),
    });
    expect(r.rows[0]).toMatchObject({ sourceId: "AD_FIRST" });
    expect(r.organic).toBe(0);
  });

  it("bounds the rows by the date window", async () => {
    const r = await acquisitionSources(workspaceId, {
      since: new Date("2026-04-01T00:00:00Z"),
    });
    // The ad contact's FIRST attributed inbound is March — outside the window.
    // The June one is inside, and within the window it IS the first.
    expect(r.rows[0]).toMatchObject({ sourceId: "AD_LATER", contacts: 1 });
  });
});

describe("per-contact acquisition", () => {
  it("returns the first attribution with its timestamp", async () => {
    const a = await contactAcquisition(workspaceId, adContact);
    expect(a).toMatchObject({
      source: "ad",
      adId: "AD_FIRST",
      headline: "Spring sale",
      at: "2026-03-01T10:00:00.000Z",
    });
  });

  it("returns null for an organic contact and for an unknown id", async () => {
    // Null, never a 404-shaped throw: the route must keep "arrived directly"
    // and "no such contact" distinguishable, and the domain layer's contract
    // is the same for both — nothing attributable found.
    const organic = await prisma.contact.findFirst({
      where: { workspaceId, identityChannel: "messenger" },
      select: { id: true },
    });
    expect(await contactAcquisition(workspaceId, organic!.id)).toBeNull();
    expect(await contactAcquisition(workspaceId, "no_such_contact")).toBeNull();
  });

  it("is tenant-scoped", async () => {
    // Another workspace asking about our contact learns nothing — the
    // workspaceId is in the WHERE, not just the route guard.
    expect(await contactAcquisition("other_workspace", adContact)).toBeNull();
  });
});
