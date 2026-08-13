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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setSharedDb } from "@/lib/db";

// The bus is irrelevant to what commits; stub publish so the send-path tests
// below don't reach for the outbox drainer / socket fanout.
vi.mock("@/lib/events/bus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events/bus")>();
  return { ...actual, publish: vi.fn(async () => undefined) };
});
// The ONLY thing standing in for Meta on the send-path tests. Everything
// below it — provider, config loader, internal senders — is production code.
vi.mock("@/lib/providers/meta-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/meta-transport")>();
  return { ...actual, metaFetch: vi.fn() };
});

import { seedWabaAccount } from "./_waba";
import { encryptSecret } from "@/lib/crypto/envelope";
import { metaFetch } from "@/lib/providers/meta-transport";
import { invalidateProviderConfig } from "@/lib/providers/config";
import { sendTextInternal } from "@/lib/messaging/send-text-internal";
import { sendTemplateInternal } from "@/lib/messaging/send-template-internal";
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
        // Its OWN WABA. The portfolio link lives on the WABA now, so the self-heal
        // attribution below has something to attach to — and giving each number a
        // DISTINCT WABA is what makes "attributed to one connection" testable.
        wabaAccountId: await seedWabaAccount(prisma, workspaceId, `${S}_waba_${suffix}`),
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
    const linked = await prisma.whatsappBusinessAccount.count({
      where: { workspaceId, portfolioId: { not: null } },
    });
    expect(linked).toBe(0);
  });

  it("a tier attributed to ONE connection mints a container for it alone", async () => {
    await persistWhatsappHealth(workspaceId, { messagingTier: "TIER_2K" }, connA);
    const [a, b] = await Promise.all([
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connA },
        select: { wabaAccount: { select: { portfolioId: true } } },
      }),
      prisma.channelConnection.findUniqueOrThrow({
        where: { id: connB },
        select: { wabaAccount: { select: { portfolioId: true } } },
      }),
    ]);
    expect(a.wabaAccount?.portfolioId).not.toBeNull();
    // The old self-heal attached this one too. Each number has its OWN WABA here,
    // and the portfolio link lives on the WABA, so B stays unattributed.
    expect(b.wabaAccount?.portfolioId ?? null).toBeNull();
    const portfolio = await prisma.whatsappPortfolio.findUniqueOrThrow({
      where: { id: a.wabaAccount!.portfolioId! },
      select: { messagingTier: true, messagingDailyCap: true },
    });
    expect(portfolio.messagingTier).toBe("TIER_2K");
    expect(portfolio.messagingDailyCap).toBe(2_000);
  });

  it("a NUMBER-level UNTIERED never clobbers the portfolio's real tier", async () => {
    // Caught live by the reconciler 2026-08-11: an unregistered number's node
    // reads whatsapp_business_manager_messaging_limit=UNTIERED while its
    // PORTFOLIO holds a real limit — linkWhatsappPortfolio wrote TIER_250 and
    // the per-number persist clobbered it back to UNTIERED on every poll.
    await persistWhatsappHealth(workspaceId, { messagingTier: "TIER_2K" }, connA);
    await persistWhatsappHealth(workspaceId, { messagingTier: "UNTIERED" }, connA);
    const conn = await prisma.channelConnection.findUniqueOrThrow({
      where: { id: connA },
      select: { wabaAccount: { select: { portfolioId: true } } },
    });
    const portfolio = await prisma.whatsappPortfolio.findUniqueOrThrow({
      where: { id: conn.wabaAccount!.portfolioId! },
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

/**
 * Send-path clear/flag scoping — the 2026-08-13 regression pin.
 *
 * `8ac565c8` added a CHANNEL-WIDE clear on the template path: account A's
 * successful template send un-flagged sibling B's real breakage. The clears
 * (and the 190 flag) now live INSIDE sendTextInternal / sendTemplateInternal /
 * executeTextSendJob, scoped to the account the thread sends from — one site
 * covers the composer, the workflow steps and `/v1` alike.
 */
describe("send-path reconnect flag scoping (2026-08-13)", () => {
  const fetchMock = vi.mocked(metaFetch);
  let convOnA = "";
  let templateOnA = "";

  const flagged = (id: string) =>
    prisma.channelConnection
      .findUniqueOrThrow({ where: { id }, select: { needsReconnect: true } })
      .then((r) => r.needsReconnect);

  beforeAll(async () => {
    // Give both accounts real (encrypted) credentials so getMetaSendConfig
    // resolves, and a fresh health stamp so nothing treats them as stale.
    for (const id of [connA, connB]) {
      await prisma.channelConnection.update({
        where: { id },
        data: {
          secrets: { accessToken: encryptSecret("tok"), appSecret: encryptSecret("sec") },
          messagingHealthUpdatedAt: new Date(),
        },
      });
    }
    invalidateProviderConfig(workspaceId);
    const contact = await prisma.contact.create({
      data: {
        workspaceId,
        name: `HY Contact ${S}`,
        identityChannel: "whatsapp",
        phoneNumber: `9615${Date.now().toString().slice(-8)}`,
        // Open 24h window so the free-form text send is allowed.
        lastInboundAt: new Date(),
      },
      select: { id: true },
    });
    convOnA = (
      await prisma.conversation.create({
        data: {
          workspaceId,
          contactId: contact.id,
          channel: "whatsapp",
          channelConnectionId: connA,
        },
        select: { id: true },
      })
    ).id;
    // A zero-variable approved template on A's OWN WABA (cross-WABA sends are
    // refused before Meta is reached — template-account-scope.spec.ts).
    const wabaOfA = (
      await prisma.channelConnection.findUniqueOrThrow({
        where: { id: connA },
        select: { wabaAccountId: true },
      })
    ).wabaAccountId!;
    templateOnA = (
      await prisma.messageTemplate.create({
        data: {
          workspaceId,
          wabaAccountId: wabaOfA,
          name: `${S}_tpl`,
          language: "en_US",
          status: "approved",
          category: "utility",
          externalId: `${S}_tpl_ext`,
          bodyText: "hello",
          components: [{ type: "BODY", text: "hello" }],
        },
        select: { id: true },
      })
    ).id;
  });

  const okSend = () =>
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ messages: [{ id: `wamid.${Date.now()}.${Math.random()}` }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  const deadToken = () =>
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({ error: { message: "Error validating access token", code: 190 } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );

  it("A's successful TEXT send clears A only — sibling B stays flagged", async () => {
    await flagChannelNeedsReconnect(workspaceId, "whatsapp", connA);
    await flagChannelNeedsReconnect(workspaceId, "whatsapp", connB);
    okSend();
    await sendTextInternal({
      workspaceId,
      conversationId: convOnA,
      body: "hi there",
      sentVia: "test",
    });
    // The clear is fire-and-forget — poll until it lands.
    await expect.poll(() => flagged(connA)).toBe(false);
    expect(await flagged(connB)).toBe(true); // the 8ac565c8-class bug cleared this
  });

  it("A's successful TEMPLATE send clears A only — sibling B stays flagged", async () => {
    await flagChannelNeedsReconnect(workspaceId, "whatsapp", connA);
    // B still flagged from the previous test's assertion; re-assert anyway.
    await flagChannelNeedsReconnect(workspaceId, "whatsapp", connB);
    okSend();
    await sendTemplateInternal({
      workspaceId,
      conversationId: convOnA,
      templateId: templateOnA,
      variables: { body: [] },
      senderUserId: null,
      sentVia: "test",
    });
    await expect.poll(() => flagged(connA)).toBe(false);
    expect(await flagged(connB)).toBe(true);
    await clearChannelNeedsReconnect(workspaceId, "whatsapp", connB);
  });

  it("a 190 on A's TEMPLATE send flags A only — templates now raise the banner too", async () => {
    deadToken();
    await expect(
      sendTemplateInternal({
        workspaceId,
        conversationId: convOnA,
        templateId: templateOnA,
        variables: { body: [] },
        senderUserId: null,
        sentVia: "test",
      }),
    ).rejects.toThrow();
    await expect.poll(() => flagged(connA)).toBe(true);
    expect(await flagged(connB)).toBe(false);
    await clearChannelNeedsReconnect(workspaceId, "whatsapp", connA);
  });

  it("a 190 on A's inline TEXT send flags A only (workflow//v1 path)", async () => {
    deadToken();
    await expect(
      sendTextInternal({
        workspaceId,
        conversationId: convOnA,
        body: "hi again",
        sentVia: "test",
      }),
    ).rejects.toThrow();
    await expect.poll(() => flagged(connA)).toBe(true);
    expect(await flagged(connB)).toBe(false);
    await clearChannelNeedsReconnect(workspaceId, "whatsapp", connA);
  });
});
