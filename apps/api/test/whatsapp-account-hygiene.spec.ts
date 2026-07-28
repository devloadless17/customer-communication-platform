/**
 * Per-account reconnect flags + portfolio hygiene.
 *
 * Three multi-account bugs pinned here:
 *  - `flagChannelNeedsReconnect` was (workspace, channel)-wide: one number's
 *    expired token marked EVERY sibling as needing reconnect.
 *  - `persistWhatsappHealth`'s self-heal minted a null-id portfolio and
 *    attached every `portfolioId: null` connection to it — numbers from
 *    genuinely different Meta portfolios merged into one shared 24h budget.
 *  - Portfolio rows were never GC'd after their last connection was removed
 *    (SetNull FK), leaving stale "shared by N numbers" counts.
 *
 *   pnpm --filter @ccp/api exec vitest run test/whatsapp-account-hygiene.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import {
  flagChannelNeedsReconnect,
  clearChannelNeedsReconnect,
} from "@/lib/providers/channel-health";
import {
  gcOrphanWhatsappPortfolios,
  persistWhatsappHealth,
} from "@/lib/providers/meta-health";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `hy${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let connA = "";
let connB = "";

async function mkConn(suffix: string, extra?: Record<string, unknown>) {
  return (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_${suffix}`,
        isActive: true,
        config: { phoneNumberId: `${S}_${suffix}` },
        secrets: {},
        ...(extra ?? {}),
      },
      select: { id: true },
    })
  ).id;
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `HY Org ${S}`, status: "active" },
  });
  orgId = org.id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `HY WS ${S}`, organizationId: orgId } })
  ).id;
  connA = await mkConn("a", { isDefault: true });
  connB = await mkConn("b");
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("per-account needsReconnect", () => {
  it("flags only the account whose token failed", async () => {
    await flagChannelNeedsReconnect(workspaceId, "whatsapp", connA);
    const [a, b] = await Promise.all([
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connA },
        select: { needsReconnect: true, lastAuthErrorAt: true },
      }),
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connB },
        select: { needsReconnect: true },
      }),
    ]);
    expect(a.needsReconnect).toBe(true);
    expect(a.lastAuthErrorAt).not.toBeNull();
    expect(b.needsReconnect).toBe(false); // the old bug flagged this one too
  });

  it("clear is channel-wide by design (self-corrects on the next failed send)", async () => {
    await clearChannelNeedsReconnect(workspaceId, "whatsapp");
    const flagged = await prisma.channelConnection.count({
      where: { workspaceId, channel: "whatsapp", needsReconnect: true },
    });
    expect(flagged).toBe(0);
  });
});

describe("portfolio self-heal attribution (D2)", () => {
  it("a tier with NO attribution and several unlinked numbers mints nothing", async () => {
    // Both connections portfolio-less; an unattributable tier must not merge
    // them into one phantom shared budget.
    await persistWhatsappHealth(workspaceId, { messagingTier: "TIER_2K" });
    const portfolios = await prisma.whatsappPortfolio.count({ where: { workspaceId } });
    expect(portfolios).toBe(0);
    const linked = await prisma.channelConnection.count({
      where: { workspaceId, channel: "whatsapp", portfolioId: { not: null } },
    });
    expect(linked).toBe(0);
  });

  it("a tier attributed to ONE connection mints a container for it alone", async () => {
    await persistWhatsappHealth(workspaceId, { messagingTier: "TIER_2K" }, connA);
    const [a, b] = await Promise.all([
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connA },
        select: { portfolioId: true },
      }),
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connB },
        select: { portfolioId: true },
      }),
    ]);
    expect(a.portfolioId).not.toBeNull();
    expect(b.portfolioId).toBeNull(); // the old self-heal attached this one too
    const portfolio = await prisma.whatsappPortfolio.findUniqueOrThrow({
      where: { id: a.portfolioId! },
      select: { messagingTier: true, messagingDailyCap: true },
    });
    expect(portfolio.messagingTier).toBe("TIER_2K");
    expect(portfolio.messagingDailyCap).toBe(2_000);
  });
});

describe("orphan portfolio GC (D8)", () => {
  it("deletes rows no connection points at, and only those", async () => {
    const orphan = await prisma.whatsappPortfolio.create({
      data: { workspaceId, externalPortfolioId: `${S}_orphan` },
      select: { id: true },
    });
    await gcOrphanWhatsappPortfolios(workspaceId);
    expect(
      await prisma.whatsappPortfolio.findUnique({ where: { id: orphan.id } }),
    ).toBeNull();
    // connA's container from the previous test still has a connection — kept.
    const kept = await prisma.whatsappPortfolio.count({ where: { workspaceId } });
    expect(kept).toBe(1);
  });
});
