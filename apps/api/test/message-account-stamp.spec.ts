/**
 * A message records WHICH account carried it, permanently.
 *
 * `Conversation.channelConnectionId` answers "where does the NEXT reply go",
 * and ingest re-stamps it whenever the customer writes to a different number of
 * ours. That makes it wrong for history: a message genuinely sent from the
 * Sales number started reporting as Support the moment the customer messaged
 * Support — including in the outbound-webhook payload partners consume, which
 * resolved the account through that live pointer.
 *
 * `Message.channelConnectionId` is the immutable answer. Nullable and NOT
 * backfilled: null means "written before the column existed" and readers fall
 * back to the conversation pointer, which is exactly the old behaviour.
 *
 *   pnpm --filter @ccp/api exec vitest run test/message-account-stamp.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { createOutboundMessageIdempotent } from "@/lib/messages/idempotent-create";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `ms${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let salesId = "";
let supportId = "";
let conversationId = "";

async function mkAccount(suffix: string, isDefault: boolean) {
  return (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_${suffix}`,
        label: suffix,
        isDefault,
        isActive: true,
        config: { phoneNumberId: `${S}_${suffix}` },
        secrets: {},
      },
      select: { id: true },
    })
  ).id;
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `MS Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `MS WS ${S}`, organizationId: orgId } })
  ).id;
  salesId = await mkAccount("sales", true);
  supportId = await mkAccount("support", false);

  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      identityChannel: "whatsapp",
      phoneNumber: `${Date.now()}`.slice(-11),
      name: "MS Contact",
    },
    select: { id: true },
  });
  conversationId = (
    await prisma.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        channel: "whatsapp",
        channelConnectionId: salesId, // the thread starts on Sales
        status: "open",
        lastMessageAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("Message.channelConnectionId", () => {
  it("is stamped from the thread's account without any caller passing it", async () => {
    // ~14 outbound call sites build their own `data`; the choke point derives
    // this so none of them can forget it.
    const msg = await createOutboundMessageIdempotent({
      workspaceId,
      conversationId,
      externalId: `${S}_out_1`,
      body: "sent from sales",
      direction: "out",
      channel: "whatsapp",
      status: "sent",
    });
    expect(msg.channelConnectionId).toBe(salesId);
  });

  it("SURVIVES the conversation being re-stamped to another account", async () => {
    // The customer now messages the Support number: ingest re-points the thread.
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { channelConnectionId: supportId },
    });

    const msg = await prisma.message.findFirstOrThrow({
      where: { workspaceId, externalId: `${S}_out_1` },
      select: { channelConnectionId: true },
    });
    // This is the whole point: the send happened on Sales and still says Sales.
    expect(msg.channelConnectionId).toBe(salesId);
    expect(msg.channelConnectionId).not.toBe(supportId);

    // …while the thread correctly reports where the NEXT reply goes.
    const conv = await prisma.conversation.findFirstOrThrow({
      where: { id: conversationId },
      select: { channelConnectionId: true },
    });
    expect(conv.channelConnectionId).toBe(supportId);
  });

  it("an EXPLICIT account wins over the derivation (broadcast case)", async () => {
    // A campaign's account is authoritative: a recipient with an existing
    // thread keeps that thread's pointer, which may name a different number
    // than the campaign actually sent from.
    const msg = await createOutboundMessageIdempotent({
      workspaceId,
      conversationId,
      externalId: `${S}_out_2`,
      body: "campaign send",
      direction: "out",
      channel: "whatsapp",
      status: "sent",
      channelConnectionId: salesId, // thread points at Support right now
    });
    expect(msg.channelConnectionId).toBe(salesId);
  });

  it("an explicit NULL is respected, not overwritten by the derivation", async () => {
    const msg = await createOutboundMessageIdempotent({
      workspaceId,
      conversationId,
      externalId: `${S}_out_3`,
      body: "unattributed",
      direction: "out",
      channel: "whatsapp",
      status: "sent",
      channelConnectionId: null,
    });
    expect(msg.channelConnectionId).toBeNull();
  });
});
