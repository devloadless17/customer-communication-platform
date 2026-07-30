/**
 * Batched webhook POSTs must attribute PER EVENT, not per body.
 *
 * Meta's contract: "multiple changes from DIFFERENT OBJECTS that are of the same
 * type may be batched together", up to 1000 updates per POST, batching guaranteed
 * in neither direction. The route used to resolve ONE account for the whole body
 * (the first `metadata.phone_number_id` / `entry[].id` it found) and stamp every
 * event with it. In a two-number workspace that re-pointed the second number's
 * conversations at the FIRST number — so the agent's next reply went out an
 * account with no open 24h customer-service window — and put the wrong account on
 * every `Message` row, corrupting per-account analytics and exports.
 *
 * These tests drive the real chain: parse → `groupEventsByInboundAccount` →
 * `ingestEvents` once per group, which is exactly what the controller does.
 *
 *   pnpm --filter @ccp/api exec vitest run test/webhook-batched-entries.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";
import { seedWabaAccount } from "./_waba";

vi.mock("@/lib/events/bus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events/bus")>();
  return { ...actual, publish: vi.fn(async () => undefined) };
});

import { metaProvider } from "@/lib/providers/meta";
import { messengerProvider } from "@/lib/providers/messenger";
import { ingestWithRedelivery } from "./_ingest-redelivery";
import { groupEventsByInboundAccount } from "@/lib/providers/inbound-accounts";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `bb${Date.now().toString().slice(-8)}`;
const PN_A = `${S}_pn_a`;
const PN_B = `${S}_pn_b`;
const PN_FOREIGN = `${S}_pn_foreign`;
const WABA_A = `${S}_waba_a`;
const WABA_B = `${S}_waba_b`;
const PAGE_A = `${S}_page_a`;
const PAGE_B = `${S}_page_b`;

let orgId = "";
let workspaceId = "";
let connA = "";
let connB = "";
let pageConnA = "";
let pageConnB = "";

/** Drive the exact chain the controller drives. */
async function deliverWhatsapp(payload: unknown) {
  const events = metaProvider.parseWebhook(payload);
  const grouped = await groupEventsByInboundAccount(workspaceId, "whatsapp", events);
  for (const g of grouped.groups) {
    await ingestWithRedelivery(workspaceId, "whatsapp", g.events, g.channelConnectionId);
  }
  return grouped;
}

async function deliverMessenger(payload: unknown) {
  const events = messengerProvider.parseWebhook(payload);
  const grouped = await groupEventsByInboundAccount(workspaceId, "messenger", events);
  for (const g of grouped.groups) {
    await ingestWithRedelivery(workspaceId, "messenger", g.events, g.channelConnectionId);
  }
  return grouped;
}

function waTextChange(phoneNumberId: string, display: string, from: string, wamid: string) {
  return {
    field: "messages",
    value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: display, phone_number_id: phoneNumberId },
      contacts: [{ profile: { name: `Cust ${from}` }, wa_id: from }],
      messages: [
        { from, id: wamid, timestamp: "1738796547", type: "text", text: { body: "hi" } },
      ],
    },
  };
}

function waEnvelope(entries: Array<{ id: string; changes: unknown[] }>) {
  return { object: "whatsapp_business_account", entry: entries };
}

function fbEntry(pageId: string, psid: string, mid: string) {
  return {
    id: pageId,
    time: 1458692752478,
    messaging: [
      {
        sender: { id: psid },
        recipient: { id: pageId },
        timestamp: 1458692752478,
        message: { mid, text: "hello" },
      },
    ],
  };
}

async function messageAccount(externalId: string) {
  return prisma.message.findFirstOrThrow({
    where: { workspaceId, externalId },
    select: { channelConnectionId: true, conversationId: true },
  });
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Batch Org ${S}`, status: "active" },
  });
  orgId = org.id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `Batch WS ${S}`, organizationId: orgId } })
  ).id;

  const mkWa = async (phoneId: string, display: string, wabaId: string, isDefault: boolean) =>
    (
      await prisma.channelConnection.create({
        data: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId: phoneId,
          isDefault,
          isActive: true,
          wabaAccountId: await seedWabaAccount(prisma, workspaceId, wabaId),
          config: { phoneNumberId: phoneId, displayPhoneNumber: display },
          secrets: {},
          // NOT stale: `messagingHealthUpdatedAt: null` puts a row at the FRONT of
          // the global health sweeper's queue, and these fixtures have nothing to do
          // with health. Leaving them null made them compete for the sweeper's
          // per-tick cap and starve `whatsapp-health-per-account`'s drain loop.
          messagingHealthUpdatedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;
  connA = await mkWa(PN_A, "+1 555-020-0001", WABA_A, true);
  connB = await mkWa(PN_B, "+1 555-020-0002", WABA_B, false);

  const mkPage = async (pageId: string, isDefault: boolean) =>
    (
      await prisma.channelConnection.create({
        data: {
          workspaceId,
          channel: "messenger",
          externalAccountId: pageId,
          isDefault,
          isActive: true,
          config: { pageId },
          secrets: {},
        },
        select: { id: true },
      })
    ).id;
  pageConnA = await mkPage(PAGE_A, true);
  pageConnB = await mkPage(PAGE_B, false);
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("WhatsApp: one POST, two numbers", () => {
  it("binds each thread to the number that actually received it", async () => {
    // THE HEADLINE BUG. Before the fix both messages were stamped with whichever
    // number appeared first, and the second customer's reply went out the wrong
    // number.
    const grouped = await deliverWhatsapp(
      waEnvelope([
        { id: WABA_A, changes: [waTextChange(PN_A, "+1 555-020-0001", "16505551111", "wamid.BA1")] },
        { id: WABA_B, changes: [waTextChange(PN_B, "+1 555-020-0002", "16505552222", "wamid.BB1")] },
      ]),
    );
    expect(grouped.groups).toHaveLength(2);
    expect(grouped.dropped).toHaveLength(0);

    const a = await messageAccount("wamid.BA1");
    const b = await messageAccount("wamid.BB1");
    expect(a.channelConnectionId).toBe(connA);
    expect(b.channelConnectionId).toBe(connB);

    // The conversation pointer — what the next reply is sent from — must agree.
    const [convA, convB] = await Promise.all([
      prisma.conversation.findUniqueOrThrow({
        where: { id: a.conversationId },
        select: { channelConnectionId: true },
      }),
      prisma.conversation.findUniqueOrThrow({
        where: { id: b.conversationId },
        select: { channelConnectionId: true },
      }),
    ]);
    expect(convA.channelConnectionId).toBe(connA);
    expect(convB.channelConnectionId).toBe(connB);
  });

  it("keeps the SAME customer's two threads separate per number", async () => {
    // One person messaging both of your numbers is one Contact but two accounts.
    // This is also the case that makes sequential group ingest load-bearing —
    // concurrent groups would race `contact.update()` (P2034).
    await deliverWhatsapp(
      waEnvelope([
        { id: WABA_A, changes: [waTextChange(PN_A, "+1 555-020-0001", "16505553333", "wamid.SAME_A")] },
        { id: WABA_B, changes: [waTextChange(PN_B, "+1 555-020-0002", "16505553333", "wamid.SAME_B")] },
      ]),
    );
    const a = await messageAccount("wamid.SAME_A");
    const b = await messageAccount("wamid.SAME_B");
    expect(a.channelConnectionId).toBe(connA);
    expect(b.channelConnectionId).toBe(connB);
  });

  it("ingests the known entry and drops only the unknown one", async () => {
    const grouped = await deliverWhatsapp(
      waEnvelope([
        { id: WABA_A, changes: [waTextChange(PN_A, "+1 555-020-0001", "16505554444", "wamid.KNOWN")] },
        {
          id: "waba_someone_else",
          changes: [waTextChange(PN_FOREIGN, "+1 555-099-9999", "16505555555", "wamid.FOREIGN")],
        },
      ]),
    );
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.dropped).toEqual([
      { externalAccountId: PN_FOREIGN, count: 1, reason: "unknown_account" },
    ]);

    expect((await messageAccount("wamid.KNOWN")).channelConnectionId).toBe(connA);
    expect(
      await prisma.message.findFirst({ where: { workspaceId, externalId: "wamid.FOREIGN" } }),
    ).toBeNull();
  });

  it("writes nothing when every entry names an account we don't hold", async () => {
    const grouped = await deliverWhatsapp(
      waEnvelope([
        {
          id: "waba_someone_else",
          changes: [waTextChange(PN_FOREIGN, "+1 555-099-9999", "16505556666", "wamid.ALL_FOREIGN")],
        },
      ]),
    );
    expect(grouped.groups).toHaveLength(0);
    expect(
      await prisma.message.findFirst({ where: { workspaceId, externalId: "wamid.ALL_FOREIGN" } }),
    ).toBeNull();
  });

  it("redelivering the identical batched POST creates no duplicates", async () => {
    const body = waEnvelope([
      { id: WABA_A, changes: [waTextChange(PN_A, "+1 555-020-0001", "16505557777", "wamid.DEDUP_A")] },
      { id: WABA_B, changes: [waTextChange(PN_B, "+1 555-020-0002", "16505558888", "wamid.DEDUP_B")] },
    ]);
    await deliverWhatsapp(body);
    await deliverWhatsapp(body);
    const count = await prisma.message.count({
      where: { workspaceId, externalId: { in: ["wamid.DEDUP_A", "wamid.DEDUP_B"] } },
    });
    expect(count).toBe(2);
  });

  it("a mixed batch writes the account-level subject onto the number IT names", async () => {
    // Precedence regression: the batch-wide account used to short-circuit the
    // per-event hint lookup, so a `messages` change for A batched with a quality
    // update for B wrote B's RED onto A.
    await deliverWhatsapp(
      waEnvelope([
        { id: WABA_A, changes: [waTextChange(PN_A, "+1 555-020-0001", "16505559999", "wamid.MIXED_A")] },
        {
          id: WABA_B,
          changes: [
            {
              field: "phone_number_quality_update",
              value: {
                display_phone_number: "+1 555-020-0002",
                event: "FLAGGED",
                current_quality_rating: "RED",
              },
            },
          ],
        },
      ]),
    );
    const [a, b] = await Promise.all([
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connA },
        select: { qualityRating: true },
      }),
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connB },
        select: { qualityRating: true },
      }),
    ]);
    expect(b.qualityRating).toBe("RED");
    expect(a.qualityRating).toBeNull();
  });
});

describe("Messenger: one POST, two Pages", () => {
  it("binds each thread to the Page that received it", async () => {
    const grouped = await deliverMessenger({
      object: "page",
      entry: [fbEntry(PAGE_A, `${S}_psid_1`, "mid.PA"), fbEntry(PAGE_B, `${S}_psid_2`, "mid.PB")],
    });
    expect(grouped.groups).toHaveLength(2);
    expect((await messageAccount("mid.PA")).channelConnectionId).toBe(pageConnA);
    expect((await messageAccount("mid.PB")).channelConnectionId).toBe(pageConnB);
  });

  it("drops an account-bound event with no entry.id when several Pages exist", async () => {
    // The old code fell back to `isDefault`, binding the thread to a Page the
    // customer never messaged. With two active Pages there is no honest answer,
    // so refuse rather than guess.
    const grouped = await deliverMessenger({
      object: "page",
      entry: [{ ...fbEntry(PAGE_A, `${S}_psid_3`, "mid.NOID"), id: undefined }],
    });
    expect(grouped.groups).toHaveLength(0);
    expect(grouped.dropped).toEqual([
      { externalAccountId: undefined, count: 1, reason: "unattributable" },
    ]);
    expect(
      await prisma.message.findFirst({ where: { workspaceId, externalId: "mid.NOID" } }),
    ).toBeNull();
  });

  it("still applies an account-AGNOSTIC event from a no-entry.id payload", async () => {
    // A read watermark resolves its target by message id and never needed an
    // account, so dropping it for want of one would lose delivery/read ticks.
    // Seed an outbound to mark, then deliver a watermark with no entry.id.
    const seeded = await deliverMessenger({
      object: "page",
      entry: [fbEntry(PAGE_A, `${S}_psid_4`, "mid.SEED")],
    });
    expect(seeded.groups).toHaveLength(1);
    const conv = (await messageAccount("mid.SEED")).conversationId;
    const out = await prisma.message.create({
      data: {
        workspaceId,
        conversationId: conv,
        channel: "messenger",
        channelConnectionId: pageConnA,
        direction: "out",
        externalId: "mid.OUT_TO_READ",
        body: "are you there?",
        status: "sent",
        createdAt: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });

    const grouped = await deliverMessenger({
      object: "page",
      entry: [
        {
          id: undefined,
          time: 1458692752999,
          messaging: [
            {
              sender: { id: `${S}_psid_4` },
              recipient: { id: PAGE_A },
              timestamp: Date.now(),
              read: { watermark: Date.now() },
            },
          ],
        },
      ],
    });
    // It grouped into the UNATTRIBUTED bucket (no account needed) and applied.
    expect(grouped.dropped).toHaveLength(0);
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups[0]!.channelConnectionId).toBeUndefined();
    const after = await prisma.message.findUniqueOrThrow({
      where: { id: out.id },
      select: { status: true },
    });
    expect(after.status).toBe("read");
  });
});

describe("sole-active-account fallback", () => {
  it("attributes a no-id account-bound event when the workspace has ONE account", async () => {
    // Same payload, different workspace shape: with exactly one active Page the
    // answer is unambiguous, so it lands instead of being dropped.
    const soloWs = (
      await prisma.workspace.create({ data: { name: `Solo WS ${S}`, organizationId: orgId } })
    ).id;
    const soloConn = (
      await prisma.channelConnection.create({
        data: {
          workspaceId: soloWs,
          channel: "messenger",
          externalAccountId: `${S}_page_solo`,
          isDefault: true,
          isActive: true,
          config: { pageId: `${S}_page_solo` },
          secrets: {},
        },
        select: { id: true },
      })
    ).id;

    const events = messengerProvider.parseWebhook({
      object: "page",
      entry: [{ ...fbEntry(`${S}_page_solo`, `${S}_psid_solo`, "mid.SOLO"), id: undefined }],
    });
    const grouped = await groupEventsByInboundAccount(soloWs, "messenger", events);
    expect(grouped.dropped).toHaveLength(0);
    expect(grouped.groups).toHaveLength(1);
    expect(grouped.groups[0]!.channelConnectionId).toBe(soloConn);
  });
});
