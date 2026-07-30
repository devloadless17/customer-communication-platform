/**
 * Template analytics must belong to the account that actually sent the campaign.
 *
 * `template_analytics` is a field on the WABA node, so a campaign's figures can only
 * live under the WABA its sending number belongs to. Two things used to break that,
 * both silently — every half succeeded, so nothing surfaced:
 *
 *   1. `resolveCampaignTemplate` fell back to a same-named template on ANOTHER WABA
 *      whenever the sending WABA's catalog no longer held it. The panel then filled
 *      with a different account's numbers under this campaign's name. An empty panel
 *      is honest and prompts a re-sync; other people's figures are neither.
 *   2. The capture sweeper gated "has this tenant enabled insights?" per WORKSPACE
 *      while fetching per WABA. In a workspace with WABA-A enabled and WABA-B not,
 *      B was swept every tick and earned a guaranteed Meta refusal — the exact waste
 *      the gate exists to prevent, which moved down a level when the flag became a
 *      WABA property rather than a per-number one.
 *
 *   pnpm --filter @ccp/api exec vitest run test/analytics-account-scope.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { seedWabaAccount } from "./_waba";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto/envelope";
import { invalidateProviderConfig } from "@/lib/providers/config";
import { resolveCampaignTemplate } from "@/lib/analytics/template-analytics";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `aas${Date.now().toString().slice(-8)}`;
const NAME = `${S}_promo`;

let orgId = "";
let workspaceId = "";
let wabaA = "";
let wabaB = "";
let connA = "";
let tplB = "";

async function mkConn(suffix: string, wabaAccountId: string, isDefault: boolean) {
  return (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_${suffix}`,
        wabaAccountId,
        isDefault,
        isActive: true,
        config: { phoneNumberId: `${S}_${suffix}` },
        secrets: { accessToken: encryptSecret("tok"), appSecret: encryptSecret("sec") },
        // Not stale — keeps this fixture out of the global health sweeper's queue.
        messagingHealthUpdatedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `AAS Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `AAS WS ${S}`, organizationId: orgId } })
  ).id;

  wabaA = await seedWabaAccount(prisma, workspaceId, `${S}_waba_a`);
  wabaB = await seedWabaAccount(prisma, workspaceId, `${S}_waba_b`);
  connA = await mkConn("a", wabaA, true);
  await mkConn("b", wabaB, false);
  invalidateProviderConfig(workspaceId);

  // The SAME (name, language) exists only on WABA-B. WABA-A — the account the
  // campaign below sends from — does not have it.
  tplB = (
    await prisma.messageTemplate.create({
      data: {
        workspaceId,
        wabaAccountId: wabaB,
        name: NAME,
        language: "en_US",
        status: "approved",
        category: "marketing",
        externalId: `${S}_ext_b`,
        bodyText: "hello",
        components: [{ type: "BODY", text: "hello" }],
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("resolveCampaignTemplate", () => {
  it("returns NOTHING rather than another WABA's same-named template", async () => {
    // THE misattribution. The campaign sent from WABA-A; only WABA-B has this
    // template. Reporting B's figures here would put another account's numbers under
    // this campaign, and both the fetch and the read would succeed while doing it.
    const out = await resolveCampaignTemplate(workspaceId, {
      templateName: NAME,
      templateLanguage: "en_US",
      channelConnectionId: connA,
    });
    expect(out).toBeNull();
  });

  it("resolves when the sending account's OWN catalog holds it", async () => {
    const tplA = await prisma.messageTemplate.create({
      data: {
        workspaceId,
        wabaAccountId: wabaA,
        name: NAME,
        language: "en_US",
        status: "approved",
        category: "marketing",
        externalId: `${S}_ext_a`,
        bodyText: "hello",
        components: [{ type: "BODY", text: "hello" }],
      },
      select: { id: true },
    });
    const out = await resolveCampaignTemplate(workspaceId, {
      templateName: NAME,
      templateLanguage: "en_US",
      channelConnectionId: connA,
    });
    // A's externalId, never B's — even though B's row is the older one and would win
    // any `syncedAt`-ordered tie-break.
    expect(out).toEqual({ externalId: `${S}_ext_a`, wabaAccountId: wabaA });
    await prisma.messageTemplate.delete({ where: { id: tplA.id } });
  });

  it("still falls back for a campaign that records NO account at all", async () => {
    // `Broadcast.channelConnectionId` is nullable for pre-multi-account rows. With no
    // sending account there is no WABA to scope by, so the shared `syncedAt desc`
    // pick remains — and both callers land on the SAME pick, which is the property
    // whose absence made Fetch write one externalId while the report read another.
    const out = await resolveCampaignTemplate(workspaceId, {
      templateName: NAME,
      templateLanguage: "en_US",
      channelConnectionId: null,
    });
    expect(out).toEqual({ externalId: `${S}_ext_b`, wabaAccountId: wabaB });
    expect(tplB).toBeTruthy();
  });
});
