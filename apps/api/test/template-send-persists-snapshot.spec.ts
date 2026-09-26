/**
 * A REAL template send writes the footer + buttons snapshot onto the message.
 *
 * The builder is unit-tested on its own (template-sent-snapshot.spec.ts); this
 * drives the whole `sendTemplateInternal` path — config load, validation, the
 * WABA guard, the row write — with ONLY the final Meta call stubbed, and reads
 * the persisted Message back. It is the proof that the wiring is live, not just
 * the function: without it a regression that dropped `structured` from the
 * insert would pass every other test while every thread quietly went back to
 * body-only bubbles.
 *
 * Uses the exact template from the prod report (jaspers_market_image_cta_v1):
 * image header, body, "developers.facebook.com" footer, "Get free delivery" URL
 * button.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-send-persists-snapshot.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestPrismaClient } from "./_prisma";
import { seedWabaAccount } from "./_waba";
import { setSharedDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto/envelope";
import { invalidateProviderConfig } from "@/lib/providers/config";
import { metaProvider } from "@/lib/providers/meta";
import { sendTemplateInternal } from "@/lib/messaging/send-template-internal";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `tsp${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let conversationId = "";
let templateId = "";

const JASPERS = [
  { type: "HEADER", format: "IMAGE" },
  { type: "BODY", text: "Free delivery for all online orders with Jasper's Market" },
  { type: "FOOTER", text: "developers.facebook.com" },
  {
    type: "BUTTONS",
    buttons: [
      {
        type: "URL",
        text: "Get free delivery",
        url: "https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/utility-templates",
      },
    ],
  },
];

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `TSP Org ${S}`, status: "active" } })).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `TSP WS ${S}`, organizationId: orgId } })
  ).id;
  const wabaAccountId = await seedWabaAccount(prisma, workspaceId, `${S}_waba`);
  const accountId = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_pn`,
        wabaAccountId,
        isDefault: true,
        isActive: true,
        config: { phoneNumberId: `${S}_pn` },
        secrets: { accessToken: encryptSecret("tok"), appSecret: encryptSecret("sec") },
        messagingHealthUpdatedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
  invalidateProviderConfig(workspaceId);

  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      identityChannel: "whatsapp",
      phoneNumber: `${Date.now()}`.slice(-11),
      name: "TSP Contact",
    },
    select: { id: true },
  });
  conversationId = (
    await prisma.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        channel: "whatsapp",
        channelConnectionId: accountId,
        status: "open",
        lastMessageAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
  templateId = (
    await prisma.messageTemplate.create({
      data: {
        workspaceId,
        wabaAccountId,
        name: "jaspers_market_image_cta_v1",
        language: "en_US",
        status: "approved",
        category: "marketing",
        externalId: `${S}_tpl`,
        bodyText: "Free delivery for all online orders with Jasper's Market",
        components: JASPERS,
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("a real template send persists what the customer saw", () => {
  it("writes the footer and the URL button onto the message row", async () => {
    const sendTemplate = vi
      .spyOn(metaProvider, "sendTemplate")
      .mockResolvedValue({ externalId: `wamid.${S}`, timestamp: new Date() });

    const { messageId } = await sendTemplateInternal({
      workspaceId,
      conversationId,
      templateId,
      variables: {
        body: [],
        // A foreign link: it still SENDS (Meta fetches it), but only our own
        // template assets are pinned to the row, so no media columns here.
        headerMedia: { kind: "image", link: "https://cdn.example.com/banner.jpg" },
      },
      senderUserId: null,
      sentVia: "test",
    });

    expect(sendTemplate).toHaveBeenCalledTimes(1);
    const row = await prisma.message.findUniqueOrThrow({
      where: { id: messageId },
      select: { body: true, structured: true, mediaKind: true, templateName: true },
    });
    expect(row.body).toBe("Free delivery for all online orders with Jasper's Market");
    expect(row.templateName).toBe("jaspers_market_image_cta_v1");
    expect(row.structured).toEqual({
      kind: "template",
      footer: "developers.facebook.com",
      buttons: [
        {
          type: "url",
          text: "Get free delivery",
          url: "https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/utility-templates",
        },
      ],
    });
    // Not our asset → not pinned (see headerMediaColumns).
    expect(row.mediaKind).toBeNull();
  });
});
