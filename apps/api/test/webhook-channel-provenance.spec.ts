/**
 * Outbound-webhook provenance — the `channel` block must say WHICH account,
 * for EVERY conversation-scoped event.
 *
 * What a receiver (n8n, Zapier, a partner backend) needs from a message event
 * is "where exactly did this come from": workspace → channel → account →
 * conversation. Two things were wrong:
 *
 *  1. `resolveChannel` looked up the `isDefault: true` connection for the
 *     medium, so on a workspace with several WhatsApp numbers `channel.id` —
 *     documented as "the ChannelConnection cuid" — named the DEFAULT number on
 *     every event regardless of which number the customer actually messaged.
 *     Cached per (workspace, channel), so it was consistently wrong.
 *  2. Only 3 of the 10 conversation-scoped events carry the account on their
 *     payload. The other 7 (`message.sent`, `message.status_changed`,
 *     `note.*`, `message.flag_changed`, `ticket.changed`,
 *     `conversation.ai_changed`) fell through to that same default. They all
 *     carry `conversationId`, and the conversation owns the account, so the
 *     subscriber resolves it from there.
 *
 * And `id` on its own is an opaque cuid — useless to route on — so the block
 * now also carries the account's label, address and provider id.
 *
 *   pnpm --filter @ccp/api exec vitest run test/webhook-channel-provenance.spec.ts
 */
import { existsSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PUBLIC_EVENT_GROUPS,
  toWirePayload,
  type WireChannelBase,
} from "@ccp/shared/outbound-webhooks/public-events";

import { OutboundWebhooksSubscriber } from "@/outbound-webhooks/outbound-webhooks.subscriber";
import type { DbService } from "@/db/db.service";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();

/** The two private resolvers under test, named rather than double-asserted. */
interface ResolverSurface {
  resolveEventAccountId(
    workspaceId: string,
    raw: Record<string, unknown>,
  ): Promise<string | null>;
  resolveChannel(
    workspaceId: string,
    channel: string | null,
    accountId?: string | null,
  ): Promise<{
    id: string | null;
    name: string;
    source: string;
    account_label: string | null;
    account_address: string | null;
    account_external_id: string | null;
  } | null>;
}

const subscriber = new OutboundWebhooksSubscriber(
  prisma as unknown as DbService,
) as unknown as ResolverSurface;

const S = `cp${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let defaultConn = "";
let salesConn = "";
let conversationId = "";
let messageOnDefault = "";

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `CP Org ${S}`, status: "active" } })).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `CP WS ${S}`, organizationId: orgId } })
  ).id;

  defaultConn = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_default`,
        label: "Main",
        isDefault: true,
        isActive: true,
        config: { displayPhoneNumber: "+15550100001" },
      },
      select: { id: true },
    })
  ).id;
  salesConn = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_sales`,
        label: "Sales",
        isDefault: false,
        isActive: true,
        config: { displayPhoneNumber: "+15550100002" },
      },
      select: { id: true },
    })
  ).id;

  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      name: `CP Contact ${S}`,
      phoneNumber: `1555${S.slice(-7)}`,
      identityChannel: "whatsapp",
    },
    select: { id: true },
  });
  // The thread lives on SALES — deliberately not the default.
  conversationId = (
    await prisma.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        channel: "whatsapp",
        channelConnectionId: salesConn,
      },
      select: { id: true },
    })
  ).id;

  // A send that genuinely went out from the DEFAULT number, on a thread that
  // has since been re-stamped to SALES. The two therefore disagree, which is
  // what makes "prefer the message's own stamp" a distinguishable assertion
  // rather than one the conversation fallback would satisfy by accident.
  messageOnDefault = (
    await prisma.message.create({
      data: {
        workspaceId,
        conversationId,
        externalId: `wamid.${S}.provenance`,
        body: "sent from the default number",
        direction: "out",
        channel: "whatsapp",
        channelConnectionId: defaultConn,
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("webhook channel provenance", () => {
  it("uses the account the event CARRIES, not the workspace default", async () => {
    const accountId = await subscriber.resolveEventAccountId(workspaceId, {
      conversationId,
      conversation: { channelConnectionId: salesConn },
    });
    expect(accountId).toBe(salesConn);
  });

  it("falls back to the CONVERSATION's account for events that carry none", async () => {
    // message.sent / message.status_changed / note.* / ticket.changed all look
    // like this: a conversationId and no account. Before the fallback these
    // every one of them reported `defaultConn`.
    const accountId = await subscriber.resolveEventAccountId(workspaceId, {
      conversationId,
    });
    expect(accountId).toBe(salesConn);
    expect(accountId).not.toBe(defaultConn);
  });

  it("prefers the MESSAGE's own account over the re-stamped thread — top-level messageId", async () => {
    // The `message.status_changed` / `message.flag_changed` shape.
    const accountId = await subscriber.resolveEventAccountId(workspaceId, {
      conversationId,
      messageId: messageOnDefault,
    });
    expect(accountId).toBe(defaultConn);
    expect(accountId).not.toBe(salesConn);
  });

  it("prefers the MESSAGE's own account over the re-stamped thread — nested message.id", async () => {
    // REGRESSION PIN. `message.sent` carries the whole Message DTO instead of a
    // top-level `messageId`, so a resolver that reads only `raw.messageId` finds
    // nothing here and silently falls through to the conversation pointer —
    // reporting a send that went out from Main under Sales, to every partner
    // subscribed to the most-subscribed event in the API. Caught by
    // `tests/e2e/multi-account/03-reads-and-webhooks.spec.ts`, which is not in
    // CI; pinned here because this spec is.
    const accountId = await subscriber.resolveEventAccountId(workspaceId, {
      conversationId,
      message: { id: messageOnDefault, conversationId },
    });
    expect(accountId).toBe(defaultConn);
    expect(accountId).not.toBe(salesConn);
  });

  it("does not resolve a conversation from another workspace", async () => {
    // The id rides on an event payload, so the lookup stays workspace-scoped.
    const otherOrg = await prisma.organization.create({
      data: { name: `CP Other ${S}`, status: "active" },
    });
    const otherWs = await prisma.workspace.create({
      data: { name: `CP Other WS ${S}`, organizationId: otherOrg.id },
    });
    const leaked = await subscriber.resolveEventAccountId(otherWs.id, { conversationId });
    expect(leaked).toBeNull();
    await prisma.organization.delete({ where: { id: otherOrg.id } }).catch(() => undefined);
  });

  it("names the account on the wire — label, address and provider id, not just a cuid", async () => {
    const block = await subscriber.resolveChannel(workspaceId, "whatsapp", salesConn);
    expect(block).not.toBeNull();
    expect(block!.id).toBe(salesConn);
    expect(block!.name).toBe("whatsapp");
    expect(block!.source).toBe("whatsapp_business");
    // The part that makes the envelope self-describing: a receiver can route on
    // "+15550100002" / "Sales" instead of hardcoding a database id.
    expect(block!.account_label).toBe("Sales");
    expect(block!.account_address).toBe("+15550100002");
    expect(block!.account_external_id).toBe(`${S}_sales`);
  });
});

describe("the delivered body", () => {
  /**
   * `wireChannel` REBUILDS the channel block field by field instead of
   * spreading `WireChannelBase`, so a field can exist on the type, be set by
   * the subscriber, appear in the docs sample — and still never reach the
   * partner. That is exactly what happened when the account fields were added,
   * and only rendering a real body caught it. This asserts the delivered shape,
   * not the intermediate one.
   */
  it("carries the full provenance chain a receiver needs", () => {
    const channelBase: WireChannelBase = {
      id: "cmpchan_01",
      name: "whatsapp",
      source: "whatsapp_business",
      created_at: 1773145944,
      account_label: "Sales",
      account_address: "+15550100002",
      account_external_id: "109876543210987",
    };
    const sample = PUBLIC_EVENT_GROUPS.flatMap((g) => g.events).find(
      (e) => e.type === "message.received",
    )!;
    const body = toWirePayload("message.received", sample.samplePayload, { channelBase }) as {
      channel: Record<string, unknown>;
      conversation: Record<string, unknown>;
      message: Record<string, unknown>;
    };

    // WHICH account, in terms a flow can branch on without hardcoding a cuid.
    expect(body.channel.id).toBe("cmpchan_01");
    expect(body.channel.name).toBe("whatsapp");
    expect(body.channel.account_label).toBe("Sales");
    expect(body.channel.account_address).toBe("+15550100002");
    expect(body.channel.account_external_id).toBe("109876543210987");

    // ...and WHICH conversation / contact the message belongs to, so the chain
    // workspace → channel → account → conversation → message is complete on
    // every delivery.
    expect(body.conversation.id).toBeTruthy();
    expect(body.message.conversationId).toBe(body.conversation.id);
    expect(body.message.contactId).toBeTruthy();
  });
});
