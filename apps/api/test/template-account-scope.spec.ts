/**
 * A template can only be sent from a number in its OWN WhatsApp Business Account.
 *
 * Templates are WABA-scoped (`@@unique([workspaceId, wabaId, name, language])`),
 * so two WABAs in one workspace legitimately hold same-named templates. Meta
 * rejects a cross-WABA send per-recipient with an opaque error, which surfaces
 * as "the send just failed" with nothing pointing at the real cause.
 *
 * The BROADCAST path has guarded this since multi-account shipped
 * (broadcasts.service.ts, `template_wrong_account`). Every 1:1 path — the inbox
 * composer, `/v1`, and the workflow `send_template` step — went through
 * `sendTemplateInternal`, which loaded the template by id alone and never
 * compared WABAs. This pins the guard, and pins the `""` legacy sentinel that
 * keeps pre-multi-account catalogs sendable.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-account-scope.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { seedWabaAccount } from "./_waba";
import { encryptSecret } from "@/lib/crypto/envelope";
import { invalidateProviderConfig } from "@/lib/providers/config";
import {
  SendTemplateValidationError,
  sendTemplateInternal,
} from "@/lib/messaging/send-template-internal";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `ts${Date.now().toString().slice(-8)}`;
const WABA_A = `${S}_waba_a`;
const WABA_B = `${S}_waba_b`;

let orgId = "";
let workspaceId = "";
let convOnAId = "";
let templateAId = "";
let templateBId = "";
let accountNoWabaId = "";

async function mkAccount(suffix: string, wabaId: string | null, isDefault: boolean) {
  return (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_${suffix}`,
        wabaAccountId: wabaId ? await seedWabaAccount(prisma, workspaceId, wabaId) : null,
        isDefault,
        isActive: true,
        config: { phoneNumberId: `${S}_${suffix}` },
        secrets: { accessToken: encryptSecret("tok"), appSecret: encryptSecret("sec") },
        // Not stale — see the note in webhook-batched-entries.spec.ts.
        messagingHealthUpdatedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
}

/** An APPROVED, zero-variable template on `wabaId` — nothing else to satisfy. */
async function mkTemplate(name: string, wabaId: string) {
  return (
    await prisma.messageTemplate.create({
      data: {
        workspaceId,
        wabaAccountId: await seedWabaAccount(prisma, workspaceId, wabaId),
        name,
        language: "en_US",
        status: "approved",
        category: "utility",
        externalId: `${S}_${name}_${wabaId}`,
        bodyText: "hello",
        components: [{ type: "BODY", text: "hello" }],
      },
      select: { id: true },
    })
  ).id;
}

async function sendFromThreadOnA(templateId: string) {
  return sendTemplateInternal({
    workspaceId,
    conversationId: convOnAId,
    templateId,
    variables: { body: [] },
    senderUserId: null,
    sentVia: "test",
  });
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `TS Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `TS WS ${S}`, organizationId: orgId } })
  ).id;

  const accountAId = await mkAccount("a", WABA_A, true);
  await mkAccount("b", WABA_B, false);
  invalidateProviderConfig(workspaceId);

  const contact = await prisma.contact.create({
    data: {
      workspaceId,
      identityChannel: "whatsapp",
      phoneNumber: `${Date.now()}`.slice(-11),
      name: "TS Contact",
    },
    select: { id: true },
  });
  convOnAId = (
    await prisma.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        channel: "whatsapp",
        // The thread replies from account A, so only A's catalog is sendable.
        channelConnectionId: accountAId,
        status: "open",
        lastMessageAt: new Date(),
      },
      select: { id: true },
    })
  ).id;

  templateAId = await mkTemplate("order_update", WABA_A);
  templateBId = await mkTemplate("order_update", WABA_B);
  // A number with NO WABA linked. This is the hole the old `""` sentinel opened:
  // the guard only refused when both sides were known and DIFFERED, so a
  // WABA-less account could send any template in the workspace.
  accountNoWabaId = await mkAccount("nowaba", null, false);
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("template ↔ account WABA guard", () => {
  it("REFUSES a template from the sibling account's WABA", async () => {
    // Same name as A's template, different WABA — indistinguishable in any UI
    // that doesn't scope by account, which is exactly how this gets picked.
    await expect(sendFromThreadOnA(templateBId)).rejects.toMatchObject({
      code: "template_wrong_account",
    });
  });

  it("the refusal is a validation error, so no send is attempted", async () => {
    // Typed as validation (never retried) rather than a provider failure — a
    // cross-WABA send can never succeed on a retry.
    await expect(sendFromThreadOnA(templateBId)).rejects.toBeInstanceOf(
      SendTemplateValidationError,
    );
    // Nothing was written; the guard runs before any outbound row.
    expect(
      await prisma.message.count({ where: { workspaceId, conversationId: convOnAId } }),
    ).toBe(0);
  });

  it("REFUSES a send from a number with no WABA linked", async () => {
    // THE point of retiring the `""` sentinel. The guard used to read
    // `accountWaba && templateWaba && accountWaba !== templateWaba`, so an unknown
    // WABA on either side passed silently — a number whose WABA was never pasted
    // could send ANY of the workspace's templates. Now it is a hard refusal.
    const convOnNoWaba = await prisma.conversation.create({
      data: {
        workspaceId,
        contactId: (
          await prisma.contact.create({
            data: {
              workspaceId,
              name: "No-WABA contact",
              phoneNumber: `${S}998`,
              identityChannel: "whatsapp",
            },
            select: { id: true },
          })
        ).id,
        channel: "whatsapp",
        channelConnectionId: accountNoWabaId,
        status: "open",
        lastMessagePreview: "",
      },
      select: { id: true },
    });
    await expect(
      sendTemplateInternal({
        workspaceId,
        conversationId: convOnNoWaba.id,
        templateId: templateAId,
        variables: { body: [] },
        senderUserId: null,
        sentVia: "test",
      }),
    ).rejects.toMatchObject({ code: "waba_unknown" });
  });

  it("does NOT refuse the thread account's OWN template", async () => {
    await expect(sendFromThreadOnA(templateAId)).rejects.not.toMatchObject({
      code: "template_wrong_account",
    });
  });
});
