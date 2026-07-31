/**
 * BSUID capture from delivery statuses — the pre-emptive join that beats the
 * 30-day wa_id window closing.
 *
 * `statuses[].recipient_user_id` arrives on EVERY message status once the
 * rollout reaches the account, even for plain phone sends, so every outbound
 * teaches an active thread its BSUID. Two halves pinned here:
 *
 *   - PARSER: `recipientBsuid` is shape-gated (`<ISO>.<digits>` /
 *     `<ISO>.ENT.<digits>` — NEVER digits-only, so a bare number can't
 *     masquerade as one) and group statuses are excluded outright, mirroring
 *     the `recipientId` digits gate. A status with no recipient fields still
 *     emits — wamid matching must be unaffected.
 *   - INGEST/BACKFILL ladder (`backfillBsuidFromStatus`): no stored bsuid →
 *     fill the trio (bsuid + parentBsuid + portfolio stamp from the SENDING
 *     connection); same bsuid → fill-a-NULL satellites only; DIFFERENT stored
 *     bsuid → overwrite ONLY when the stored portfolio provably equals the
 *     sending connection's (Meta REGENERATED the id); different or unknown on
 *     either side → store nothing rather than corrupt a valid key.
 *
 *   pnpm --filter @ccp/api exec vitest run test/bsuid-status-backfill.spec.ts
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
import { backfillBsuidFromStatus } from "@/lib/identity/bsuid-reconcile";
import { ingestWithRedelivery } from "./_ingest-redelivery";
import type { NormalizedStatusUpdate } from "@ccp/shared/providers/types";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `bsb${Date.now().toString().slice(-8)}`;

function statusEnvelope(status: Record<string, unknown>) {
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
              metadata: { display_phone_number: "15550001111", phone_number_id: `${S}_pn_a` },
              statuses: [status],
            },
          },
        ],
      },
    ],
  };
}

function statusEvents(payload: unknown): NormalizedStatusUpdate[] {
  return metaProvider
    .parseWebhook(payload)
    .filter((e): e is NormalizedStatusUpdate => e.kind === "status");
}

describe("parser: recipient_user_id → recipientBsuid (shape-gated)", () => {
  it("emits recipientBsuid + recipientParentBsuid on a delivered status", () => {
    const [evt] = statusEvents(
      statusEnvelope({
        id: "wamid.P1",
        status: "delivered",
        timestamp: "1785400000",
        recipient_id: "96170000001",
        recipient_user_id: "LB.946402411360800",
        recipient_parent_user_id: "US.ENT.946402411360800",
      }),
    );
    expect(evt).toBeDefined();
    expect(evt!.status).toBe("delivered");
    expect(evt!.recipientId).toBe("96170000001");
    expect(evt!.recipientBsuid).toBe("LB.946402411360800");
    expect(evt!.recipientParentBsuid).toBe("US.ENT.946402411360800");
  });

  it("emits recipientBsuid on a read status too", () => {
    const [evt] = statusEvents(
      statusEnvelope({
        id: "wamid.P2",
        status: "read",
        timestamp: "1785400000",
        recipient_user_id: "LB.555",
      }),
    );
    expect(evt!.status).toBe("read");
    expect(evt!.recipientBsuid).toBe("LB.555");
  });

  it("REJECTS a digits-only recipient_user_id — a phone can't masquerade as a BSUID", () => {
    const [evt] = statusEvents(
      statusEnvelope({
        id: "wamid.P3",
        status: "delivered",
        timestamp: "1785400000",
        recipient_user_id: "946402411360800",
      }),
    );
    expect(evt).toBeDefined();
    expect(evt!.recipientBsuid).toBeUndefined();
  });

  it("REJECTS group statuses outright — there the recipient is the GROUP", () => {
    const [evt] = statusEvents(
      statusEnvelope({
        id: "wamid.P4",
        status: "delivered",
        timestamp: "1785400000",
        recipient_type: "group",
        recipient_id: "120363023735881000",
        recipient_user_id: "LB.777",
        recipient_parent_user_id: "US.ENT.777",
      }),
    );
    expect(evt).toBeDefined();
    expect(evt!.recipientId).toBeUndefined();
    expect(evt!.recipientBsuid).toBeUndefined();
    expect(evt!.recipientParentBsuid).toBeUndefined();
  });

  it("REJECTS a malformed parent id (parent must be <ISO>.ENT.<id>)", () => {
    const [evt] = statusEvents(
      statusEnvelope({
        id: "wamid.P5",
        status: "delivered",
        timestamp: "1785400000",
        recipient_user_id: "LB.888",
        recipient_parent_user_id: "US.888",
      }),
    );
    expect(evt!.recipientBsuid).toBe("LB.888");
    expect(evt!.recipientParentBsuid).toBeUndefined();
  });

  it("still emits the status when recipient fields are absent — wamid matching is unaffected", () => {
    const [evt] = statusEvents(
      statusEnvelope({ id: "wamid.P6", status: "delivered", timestamp: "1785400000" }),
    );
    expect(evt).toBeDefined();
    expect(evt!.externalId).toBe("wamid.P6");
    expect(evt!.recipientId).toBeUndefined();
    expect(evt!.recipientBsuid).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ingest + backfill ladder, against the real database.
// ---------------------------------------------------------------------------

let orgId = "";
let workspaceId = "";
let portfolioA = "";
let portfolioB = "";
let connA = "";
let connNoWaba = "";

async function makeContact(overrides: {
  phone?: string;
  bsuid?: string | null;
  parentBsuid?: string | null;
  bsuidPortfolioId?: string | null;
}): Promise<string> {
  const row = await prisma.contact.create({
    data: {
      workspaceId,
      name: `BSUID ${overrides.phone ?? overrides.bsuid ?? "x"}`,
      identityChannel: "whatsapp",
      phoneNumber: overrides.phone ?? null,
      bsuid: overrides.bsuid ?? null,
      parentBsuid: overrides.parentBsuid ?? null,
      bsuidPortfolioId: overrides.bsuidPortfolioId ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

/** Outbound message on its own conversation, stamped with the SENDING account. */
async function makeOutbound(
  contactId: string,
  wamid: string,
  channelConnectionId: string | null,
): Promise<string> {
  const conv = await prisma.conversation.create({
    data: { workspaceId, contactId, channel: "whatsapp", channelConnectionId },
    select: { id: true },
  });
  const msg = await prisma.message.create({
    data: {
      workspaceId,
      conversationId: conv.id,
      channel: "whatsapp",
      channelConnectionId,
      direction: "out",
      externalId: wamid,
      body: "outbound under test",
      status: "sent",
    },
    select: { id: true },
  });
  return msg.id;
}

async function contactRow(id: string) {
  return prisma.contact.findUniqueOrThrow({
    where: { id },
    select: { bsuid: true, parentBsuid: true, bsuidPortfolioId: true },
  });
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `Bsb Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `Bsb WS ${S}`, organizationId: orgId } })
  ).id;
  portfolioA = (
    await prisma.whatsappPortfolio.create({ data: { workspaceId }, select: { id: true } })
  ).id;
  portfolioB = (
    await prisma.whatsappPortfolio.create({ data: { workspaceId }, select: { id: true } })
  ).id;
  const mkConn = async (phoneId: string, wabaExt: string | null, portfolioId?: string) =>
    (
      await prisma.channelConnection.create({
        data: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId: phoneId,
          isDefault: false,
          isActive: true,
          ...(wabaExt
            ? { wabaAccountId: await seedWabaAccount(prisma, workspaceId, wabaExt, { portfolioId }) }
            : {}),
          config: { phoneNumberId: phoneId, displayPhoneNumber: "+1 555-020-0001" },
          secrets: {},
          // Keep these fixtures out of the health sweeper's queue (see
          // webhook-batched-entries.spec.ts for the why).
          messagingHealthUpdatedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;
  connA = await mkConn(`${S}_pn_a`, `${S}_waba_a`, portfolioA);
  connNoWaba = await mkConn(`${S}_pn_nowaba`, null);
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("ingest: a delivered status teaches the thread its BSUID", () => {
  it("backfills the contact's null bsuid + portfolio from the SENDING connection", async () => {
    const contactId = await makeContact({ phone: `961${S.replace(/\D/g, "")}01` });
    await makeOutbound(contactId, `wamid.${S}_BF1`, connA);

    const events = statusEvents(
      statusEnvelope({
        id: `wamid.${S}_BF1`,
        status: "delivered",
        timestamp: "1785400000",
        recipient_user_id: "LB.900001",
        recipient_parent_user_id: "US.ENT.900001",
      }),
    );
    expect(events).toHaveLength(1);
    await ingestWithRedelivery(workspaceId, "whatsapp", events, connA);

    // The status write itself is awaited by ingest…
    const msg = await prisma.message.findFirstOrThrow({
      where: { workspaceId, externalId: `wamid.${S}_BF1` },
      select: { status: true },
    });
    expect(msg.status).toBe("delivered");

    // …the identity backfill is fire-and-forget, so converge on it.
    await waitFor(
      async () => (await contactRow(contactId)).bsuid === "LB.900001",
      "status backfill to land the bsuid",
    );
    const row = await contactRow(contactId);
    expect(row.parentBsuid).toBe("US.ENT.900001");
    // Portfolio stamped from the SENDING connection: connA → waba_a → portfolioA.
    expect(row.bsuidPortfolioId).toBe(portfolioA);
  });

  it("advances the message by wamid exactly as before when no recipient fields arrive", async () => {
    const contactId = await makeContact({ phone: `961${S.replace(/\D/g, "")}02` });
    await makeOutbound(contactId, `wamid.${S}_BF2`, connA);

    const events = statusEvents(
      statusEnvelope({ id: `wamid.${S}_BF2`, status: "delivered", timestamp: "1785400000" }),
    );
    await ingestWithRedelivery(workspaceId, "whatsapp", events, connA);

    const msg = await prisma.message.findFirstOrThrow({
      where: { workspaceId, externalId: `wamid.${S}_BF2` },
      select: { status: true },
    });
    expect(msg.status).toBe("delivered");
    const row = await contactRow(contactId);
    expect(row.bsuid).toBeNull();
  });
});

describe("backfillBsuidFromStatus ladder", () => {
  it("different stored bsuid + DIFFERENT portfolio → untouched (sibling portfolio's key)", async () => {
    const contactId = await makeContact({
      phone: `961${S.replace(/\D/g, "")}03`,
      bsuid: "LB.OLD3",
      bsuidPortfolioId: portfolioB,
    });
    await backfillBsuidFromStatus(workspaceId, contactId, {
      bsuid: "LB.NEW3",
      parentBsuid: null,
      sendingConnectionId: connA, // portfolioA ≠ portfolioB
    });
    const row = await contactRow(contactId);
    expect(row.bsuid).toBe("LB.OLD3");
    expect(row.bsuidPortfolioId).toBe(portfolioB);
  });

  it("different stored bsuid + UNKNOWN portfolio on either side → untouched", async () => {
    // Stored side unknown.
    const a = await makeContact({
      phone: `961${S.replace(/\D/g, "")}04`,
      bsuid: "LB.OLD4",
      bsuidPortfolioId: null,
    });
    await backfillBsuidFromStatus(workspaceId, a, {
      bsuid: "LB.NEW4",
      parentBsuid: null,
      sendingConnectionId: connA,
    });
    expect((await contactRow(a)).bsuid).toBe("LB.OLD4");

    // Sending side unknown (connection with no WABA → no portfolio).
    const b = await makeContact({
      phone: `961${S.replace(/\D/g, "")}05`,
      bsuid: "LB.OLD5",
      bsuidPortfolioId: portfolioA,
    });
    await backfillBsuidFromStatus(workspaceId, b, {
      bsuid: "LB.NEW5",
      parentBsuid: null,
      sendingConnectionId: connNoWaba,
    });
    expect((await contactRow(b)).bsuid).toBe("LB.OLD5");

    // No sending connection at all.
    await backfillBsuidFromStatus(workspaceId, b, {
      bsuid: "LB.NEW5",
      parentBsuid: null,
      sendingConnectionId: null,
    });
    expect((await contactRow(b)).bsuid).toBe("LB.OLD5");
  });

  it("different stored bsuid + SAME portfolio → overwritten (Meta regenerated it)", async () => {
    const contactId = await makeContact({
      phone: `961${S.replace(/\D/g, "")}06`,
      bsuid: "LB.OLD6",
      parentBsuid: "US.ENT.OLD6",
      bsuidPortfolioId: portfolioA,
    });
    await backfillBsuidFromStatus(workspaceId, contactId, {
      bsuid: "LB.NEW6",
      parentBsuid: "US.ENT.NEW6",
      sendingConnectionId: connA,
    });
    const row = await contactRow(contactId);
    expect(row.bsuid).toBe("LB.NEW6");
    // A regeneration means the stored pairing is stale — the event's parent wins.
    expect(row.parentBsuid).toBe("US.ENT.NEW6");
    expect(row.bsuidPortfolioId).toBe(portfolioA);
  });

  it("same bsuid → fills only the NULL satellites (idempotent redelivery)", async () => {
    const contactId = await makeContact({
      phone: `961${S.replace(/\D/g, "")}07`,
      bsuid: "LB.SAME7",
      parentBsuid: null,
      bsuidPortfolioId: null,
    });
    await backfillBsuidFromStatus(workspaceId, contactId, {
      bsuid: "LB.SAME7",
      parentBsuid: "US.ENT.SAME7",
      sendingConnectionId: connA,
    });
    const row = await contactRow(contactId);
    expect(row.bsuid).toBe("LB.SAME7");
    expect(row.parentBsuid).toBe("US.ENT.SAME7");
    expect(row.bsuidPortfolioId).toBe(portfolioA);

    // Redeliver — nothing left to fill, nothing overwritten.
    await backfillBsuidFromStatus(workspaceId, contactId, {
      bsuid: "LB.SAME7",
      parentBsuid: "US.ENT.OTHER7",
      sendingConnectionId: connA,
    });
    expect((await contactRow(contactId)).parentBsuid).toBe("US.ENT.SAME7");
  });
});
