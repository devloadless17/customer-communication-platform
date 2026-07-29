/**
 * Per-account WhatsApp health polling.
 *
 * A workspace may hold SEVERAL WhatsApp numbers, but `fetchWhatsappHealthFromGraph`
 * used to take only a workspaceId and resolve credentials via the DEFAULT
 * account. Two failure modes fell out of that:
 *
 *   1. With 2+ active numbers, `getMetaSendConfig(workspaceId)` refuses
 *      (`account-unresolved`) and the fetch silently no-ops — so the sweeper,
 *      the connect-time seed, the settings Refresh button and the broadcast
 *      re-poll ALL stopped polling the moment a second number was connected.
 *   2. Even before that refusal existed, the sweeper selected a STALE
 *      non-default connection but then refreshed the workspace default —
 *      the stale row's snapshot never advanced, forever.
 *
 * These tests pin the fix: the fetch targets the named connection, the sweeper
 * refreshes the row it selected, and the no-id multi-account call remains a
 * harmless no-op (fail-safe, never a wrong-row write).
 *
 *   pnpm --filter @ccp/api exec vitest run test/whatsapp-health-per-account.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";

vi.mock("@/lib/providers/meta-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/meta-graph")>();
  return { ...actual, graphGetJson: vi.fn() };
});

import { graphGetJson } from "@/lib/providers/meta-graph";
import { fetchWhatsappHealthFromGraph } from "@/lib/providers/meta-health";
import { invalidateProviderConfig } from "@/lib/providers/config";
import { sweepWhatsappHealthOnce } from "@/lib/sweepers/whatsapp-health-refresh";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `hp${Date.now().toString().slice(-8)}`;
const PHONE_A = `${S}_phone_a`;
const PHONE_B = `${S}_phone_b`;
const WABA = `${S}_waba`;
const PORTFOLIO = `${S}_portfolio`;

let orgId = "";
let workspaceId = "";
let connA = "";
let connB = "";

const mockedGraph = vi.mocked(graphGetJson);

/** Route the mock by URL the way Graph would answer. */
function armGraphMock() {
  mockedGraph.mockImplementation(async (url: string) => {
    if (url.includes(PHONE_B)) {
      return {
        whatsapp_business_manager_messaging_limit: "TIER_2K",
        quality_rating: "GREEN",
        throughput: { level: "HIGH" },
      };
    }
    if (url.includes(PHONE_A)) {
      return {
        whatsapp_business_manager_messaging_limit: "TIER_2K",
        quality_rating: "YELLOW",
        throughput: { level: "STANDARD" },
      };
    }
    if (url.includes(`/${WABA}?`) && url.includes("owner_business_info")) {
      return { owner_business_info: { id: PORTFOLIO } };
    }
    if (url.includes(PORTFOLIO)) {
      return {
        whatsapp_business_manager_messaging_limit: "TIER_2K",
        verification_status: "verified",
      };
    }
    // A FOREIGN connection, not one of ours. `sweepWhatsappHealthOnce` sweeps
    // every active WhatsApp connection ON THE PLATFORM, so under a full
    // parallel run it legitimately reaches fixtures owned by other specs
    // (e2e-multi-account-team, webhook-subscription-health's row, whatever a
    // concurrent file just created). Throwing here made this spec fail
    // intermittently for a reason that has nothing to do with what it asserts.
    //
    // Answer benignly instead — but ONLY for rows that are not ours. An
    // unexpected call naming one of THIS spec's ids is still a genuine
    // surprise and still throws, so the signal the throw existed for is kept.
    if ([PHONE_A, PHONE_B, WABA, PORTFOLIO].some((id) => url.includes(id))) {
      throw new Error(`unexpected graph call for OUR fixture: ${url}`);
    }
    return {
      whatsapp_business_manager_messaging_limit: "TIER_1K",
      quality_rating: "GREEN",
      throughput: { level: "STANDARD" },
    };
  });
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `HP Org ${S}`, status: "active" },
  });
  orgId = org.id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `HP WS ${S}`, organizationId: orgId } })
  ).id;

  // Two ACTIVE numbers — the shape that used to kill all polling. Plaintext
  // "secrets" ride the decryptSecret legacy passthrough.
  connA = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: PHONE_A,
        isDefault: true,
        isActive: true,
        config: { phoneNumberId: PHONE_A, wabaId: WABA },
        secrets: { accessToken: `${S}_token` },
      },
      select: { id: true },
    })
  ).id;
  connB = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: PHONE_B,
        isActive: true,
        config: { phoneNumberId: PHONE_B, wabaId: WABA },
        secrets: { accessToken: `${S}_token` },
      },
      select: { id: true },
    })
  ).id;
});

beforeEach(() => {
  mockedGraph.mockReset();
  armGraphMock();
  // Config results (including the cached account-unresolved refusal) must not
  // leak across tests.
  invalidateProviderConfig(workspaceId);
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("fetchWhatsappHealthFromGraph per account", () => {
  it("writes the polled number's health onto THAT row and leaves the sibling untouched", async () => {
    await fetchWhatsappHealthFromGraph(workspaceId, connB);

    const [a, b] = await Promise.all([
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connA },
        select: { qualityRating: true, throughputLevel: true, portfolioId: true },
      }),
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connB },
        select: { qualityRating: true, throughputLevel: true, portfolioId: true },
      }),
    ]);
    expect(b.qualityRating).toBe("GREEN");
    expect(b.throughputLevel).toBe("HIGH");
    // The non-polled DEFAULT must not have been written — that was the old bug
    // in reverse (number B's health landing on number A).
    expect(a.qualityRating).toBeNull();
    expect(a.throughputLevel).toBeNull();

    // Portfolio discovery ran for the POLLED connection's WABA.
    expect(b.portfolioId).not.toBeNull();
    const portfolio = await prisma.whatsappPortfolio.findUniqueOrThrow({
      where: { id: b.portfolioId! },
      select: { externalPortfolioId: true, messagingTier: true, messagingDailyCap: true },
    });
    expect(portfolio.externalPortfolioId).toBe(PORTFOLIO);
    expect(portfolio.messagingTier).toBe("TIER_2K");
    expect(portfolio.messagingDailyCap).toBe(2_000);
  });

  it("no-id with several active numbers is a no-op — no Graph call, no row touched", async () => {
    await fetchWhatsappHealthFromGraph(workspaceId);

    expect(mockedGraph).not.toHaveBeenCalled();
    const a = await prisma.channelConnection.findUniqueOrThrow({
      where: { id: connA },
      select: { qualityRating: true },
    });
    // Still null from the previous test — the default was never written.
    expect(a.qualityRating).toBeNull();
  });
});

describe("health refresh sweeper", () => {
  it("refreshes the stale NON-default connection it selected", async () => {
    // Both rows stale; the old sweeper would resolve the workspace default for
    // each selected row (and with 2 active numbers, no-op entirely).
    await prisma.channelConnection.updateMany({
      where: { id: { in: [connA, connB] } },
      data: { messagingHealthUpdatedAt: null, qualityRating: null, throughputLevel: null },
    });
    invalidateProviderConfig(workspaceId);

    // Other stale rows may exist in a shared dev DB and compete for the
    // per-tick cap; a couple of passes drains ours through deterministically.
    for (let pass = 0; pass < 3; pass++) {
      await sweepWhatsappHealthOnce();
      const pending = await prisma.channelConnection.count({
        where: { id: { in: [connA, connB] }, messagingHealthUpdatedAt: null },
      });
      if (pending === 0) break;
    }

    const [a, b] = await Promise.all([
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connA },
        select: { qualityRating: true, messagingHealthUpdatedAt: true },
      }),
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connB },
        select: { qualityRating: true, messagingHealthUpdatedAt: true },
      }),
    ]);
    // Each row got ITS OWN number's health — not the default's, not nothing.
    expect(a.qualityRating).toBe("YELLOW");
    expect(b.qualityRating).toBe("GREEN");
    expect(a.messagingHealthUpdatedAt).not.toBeNull();
    expect(b.messagingHealthUpdatedAt).not.toBeNull();
  });
});
