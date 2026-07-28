/**
 * Portfolio-scoped messaging limit.
 *
 * Meta moved the WhatsApp 24h messaging limit from per-number to per-BUSINESS
 * PORTFOLIO on 2025-10-07: every number in a portfolio draws on ONE shared
 * budget of unique recipients. Getting this wrong is expensive in both
 * directions — count per-number and a two-number portfolio appears to have
 * double its real budget (so we wave through a send Meta will reject); count
 * across unrelated portfolios and we refuse sends that were actually fine.
 *
 * These tests drive the real gate against a real database:
 *   - recipients messaged from number A are charged against number B's budget
 *     (same portfolio, shared limit),
 *   - a SECOND portfolio in the same workspace keeps its own independent budget,
 *   - a workspace with no snapshot stays ungated (fail-open is deliberate: we
 *     don't block a working setup on a stat we haven't synced),
 *   - re-messaging someone already inside the window costs no extra budget.
 *
 *   pnpm --filter @ccp/api exec vitest run test/portfolio-messaging-limit.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { checkBroadcastEligibility } from "@/lib/providers/meta-health";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `pf${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let portfolioId = "";
let numberA = "";
let numberB = "";
const contactIds: string[] = [];

/** A delivered broadcast of `n` recipients sent from `accountId`, inside the window. */
async function sentBroadcast(accountId: string | null, n: number, offset = 0) {
  const b = await prisma.broadcast.create({
    data: {
      workspaceId,
      channel: "whatsapp",
      kind: "template",
      status: "completed",
      totalCount: n,
      sentCount: n,
      variables: {},
      audienceMode: "all",
      ...(accountId ? { channelConnectionId: accountId } : {}),
    },
    select: { id: true },
  });
  await prisma.broadcastRecipient.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      broadcastId: b.id,
      contactId: contactIds[offset + i]!,
      status: "sent" as const,
      sentAt: new Date(),
    })),
  });
  return b.id;
}

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `PF Org ${S}`, status: "active" },
  });
  orgId = org.id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `PF WS ${S}`, organizationId: orgId } })
  ).id;

  // One portfolio, TWO numbers under it — the shared-budget case.
  portfolioId = (
    await prisma.whatsappPortfolio.create({
      data: {
        workspaceId,
        messagingTier: "TIER_250",
        messagingDailyCap: 250,
        messagingHealthUpdatedAt: new Date(),
      },
    })
  ).id;
  numberA = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_a`,
        isDefault: true,
        portfolioId,
        config: { phoneNumberId: `${S}_a` },
        secrets: {},
      },
    })
  ).id;
  numberB = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_b`,
        portfolioId,
        config: { phoneNumberId: `${S}_b` },
        secrets: {},
      },
    })
  ).id;

  for (let i = 0; i < 60; i++) {
    const c = await prisma.contact.create({
      data: {
        workspaceId,
        name: `PF ${i}`,
        phoneNumber: `+99${S}${String(i).padStart(3, "0")}`,
        identityChannel: "whatsapp",
      },
      select: { id: true },
    });
    contactIds.push(c.id);
  }
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("portfolio budget", () => {
  it("charges a send from number A against the budget number B also draws on", async () => {
    // 40 unique recipients messaged from number A.
    await sentBroadcast(numberA, 40, 0);

    // The gate is asked about a send that would go out from number B. Both
    // numbers share ONE 250-recipient portfolio budget, so A's 40 must already
    // be spent — a per-number count would report 0 used here.
    const res = await checkBroadcastEligibility(workspaceId, 10, contactIds.slice(40, 50));
    expect(res.recentUniqueRecipients).toBe(40);
    expect(res.remainingDailyBudget).toBe(210);
    expect(res.allowed).toBe(true);
  });

  it("does not charge a DIFFERENT portfolio's spend against this one", async () => {
    // A second portfolio in the same workspace — independent Meta budget.
    const otherPortfolio = await prisma.whatsappPortfolio.create({
      data: {
        workspaceId,
        externalPortfolioId: `${S}_other`,
        messagingTier: "TIER_250",
        messagingDailyCap: 250,
        messagingHealthUpdatedAt: new Date(),
      },
      select: { id: true },
    });
    const otherNumber = await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_c`,
        portfolioId: otherPortfolio.id,
        config: { phoneNumberId: `${S}_c` },
        secrets: {},
      },
      select: { id: true },
    });
    await sentBroadcast(otherNumber.id, 10, 50);

    // Still 40 — the other portfolio's 10 are its own problem.
    const res = await checkBroadcastEligibility(workspaceId, 5, contactIds.slice(40, 45));
    expect(res.recentUniqueRecipients).toBe(40);
  });

  it("does not double-charge a contact already inside the rolling window", async () => {
    // Re-messaging the SAME 40 costs nothing: Meta counts unique recipients.
    const res = await checkBroadcastEligibility(workspaceId, 40, contactIds.slice(0, 40));
    expect(res.allowed).toBe(true);
    expect(res.remainingDailyBudget).toBe(210);
  });

  it("blocks when the audience's NEW recipients would exceed the shared cap", async () => {
    // 210 remaining, asking for 240 brand-new recipients.
    const fresh = Array.from({ length: 240 }, (_, i) => `nope-${i}`);
    const res = await checkBroadcastEligibility(workspaceId, 240, fresh);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBeTruthy();
  });

  it("stays ungated when the portfolio has no snapshot", async () => {
    // Fail-OPEN on unknown is deliberate: Meta enforces the real limit anyway,
    // and blocking a working setup on an unsynced stat is the worse failure.
    await prisma.whatsappPortfolio.update({
      where: { id: portfolioId },
      data: { messagingTier: null, messagingDailyCap: null },
    });
    const res = await checkBroadcastEligibility(workspaceId, 100_000);
    expect(res.allowed).toBe(true);
    expect(res.messagingDailyCap).toBeNull();
  });
});
