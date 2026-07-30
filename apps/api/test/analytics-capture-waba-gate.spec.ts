/**
 * The analytics capture sweeper must gate on insights PER WABA, not per workspace.
 *
 * Meta refuses `template_analytics` for a WABA that has not had
 * `is_enabled_for_insights` switched on, so the sweeper checks first — otherwise it
 * spends Graph budget on a guaranteed error every tick.
 *
 * That check used to be per WORKSPACE, which was right while the flag lived on
 * `ChannelConnection` and a workspace effectively had one. Once insights became a
 * WABA-level property (which is what Meta actually scopes it to), a workspace with
 * WABA-A enabled and WABA-B not passed the gate as a whole and then fetched BOTH —
 * so B earned the guaranteed refusal the gate exists to prevent, on every tick,
 * forever.
 *
 * `refreshTemplateAnalytics` is mocked: what is under test is WHICH WABAs the sweeper
 * decides to fetch, not the Graph call.
 *
 *   pnpm --filter @ccp/api exec vitest run test/analytics-capture-waba-gate.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { seedWabaAccount } from "./_waba";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";

const refreshCalls: Array<{ workspaceId: string; wabaAccountId: string }> = [];
vi.mock("@/lib/analytics/template-analytics", () => ({
  refreshTemplateAnalytics: vi.fn(
    async (workspaceId: string, opts: { wabaAccountId: string }) => {
      refreshCalls.push({ workspaceId, wabaAccountId: opts.wabaAccountId });
      return { rows: 0, costWithheld: false };
    },
  ),
}));

import { sweepTemplateAnalyticsCaptureOnce } from "@/lib/sweepers/template-analytics-capture";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `acg${Date.now().toString().slice(-8)}`;
const NAME_A = `${S}_tpl_a`;
const NAME_B = `${S}_tpl_b`;

let orgId = "";
let workspaceId = "";
let wabaEnabled = "";
let wabaNotEnabled = "";

async function seedCampaign(templateName: string, channelConnectionId: string) {
  await prisma.broadcast.create({
    data: {
      workspaceId,
      name: `camp ${templateName}`,
      channel: "whatsapp",
      kind: "template",
      status: "completed",
      templateName,
      templateLanguage: "en_US",
      channelConnectionId,
      audienceMode: "all",
      variables: {},
      // Inside the sweeper's lookback so it is a candidate at all.
      startedAt: new Date(Date.now() - 2 * 3_600_000),
      completedAt: new Date(Date.now() - 3_600_000),
    },
  });
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `ACG Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `ACG WS ${S}`, organizationId: orgId } })
  ).id;

  // ONE workspace, TWO WABAs — insights enabled on exactly one of them.
  wabaEnabled = (
    await prisma.whatsappBusinessAccount.create({
      data: {
        workspaceId,
        externalWabaId: `${S}_waba_on`,
        insightsEnabledAt: new Date(Date.now() - 86_400_000),
      },
      select: { id: true },
    })
  ).id;
  wabaNotEnabled = await seedWabaAccount(prisma, workspaceId, `${S}_waba_off`);

  const mkConn = async (suffix: string, wabaAccountId: string, isDefault: boolean) =>
    (
      await prisma.channelConnection.create({
        data: {
          workspaceId,
          channel: "whatsapp",
          externalAccountId: `${S}_${suffix}`,
          wabaAccountId,
          isDefault,
          isActive: true,
          config: { phoneNumberId: `${S}_${suffix}` },
          secrets: {},
          messagingHealthUpdatedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;
  const connOn = await mkConn("on", wabaEnabled, true);
  const connOff = await mkConn("off", wabaNotEnabled, false);

  const mkTpl = async (name: string, wabaAccountId: string) =>
    prisma.messageTemplate.create({
      data: {
        workspaceId,
        wabaAccountId,
        name,
        language: "en_US",
        status: "approved",
        category: "marketing",
        externalId: `${S}_ext_${name}`,
        bodyText: "hi",
        components: [{ type: "BODY", text: "hi" }],
      },
    });
  await mkTpl(NAME_A, wabaEnabled);
  await mkTpl(NAME_B, wabaNotEnabled);

  await seedCampaign(NAME_A, connOn);
  await seedCampaign(NAME_B, connOff);
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("capture sweeper insights gate", () => {
  it("fetches the insights-ENABLED WABA and never the one that opted out", async () => {
    refreshCalls.length = 0;
    await sweepTemplateAnalyticsCaptureOnce();

    const mine = refreshCalls.filter((c) => c.workspaceId === workspaceId);
    const fetched = new Set(mine.map((c) => c.wabaAccountId));

    // POSITIVE — the enabled WABA is still swept. A gate that skipped everything
    // would "pass" the negative half below while losing the perishable read/click
    // counts this sweeper exists to preserve.
    expect(fetched.has(wabaEnabled)).toBe(true);
    // NEGATIVE — the opted-out WABA is never asked for. Before the fix its
    // workspace-mate's enablement carried it through the gate, and Meta refused it
    // on every tick.
    expect(fetched.has(wabaNotEnabled)).toBe(false);
  });
});
