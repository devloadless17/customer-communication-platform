/**
 * The performance report breaks volume down PER ACCOUNT.
 *
 * `channels` answers "how much WhatsApp". On a workspace running a Sales and a
 * Support number that is the wrong grain — the two are separate businesses
 * sharing a medium, and "is the Support line drowning?" was unanswerable.
 *
 * The interesting part is the COALESCE. `Message.channelConnectionId` is the
 * immutable record of which account carried a message, but it only exists from
 * the day it shipped: older rows are NULL by design (backfilling them from the
 * conversation's CURRENT pointer would have invented history, since that
 * pointer re-stamps on every inbound to a different number). So the report
 * falls back to the conversation pointer for old rows — the best available
 * answer — while new rows keep their exact one. A report spanning that boundary
 * has to stay readable instead of lumping months into "unattributed".
 *
 *   pnpm --filter @ccp/api exec vitest run test/reports-accounts.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { createTestPrismaClient } from "./_prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { getWorkspaceReport } from "@/lib/analytics/reports";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `ra${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
let salesId = "";
let supportId = "";
let salesConvId = "";
let supportConvId = "";

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-07-15T00:00:00.000Z");
const AT = new Date("2026-07-05T12:00:00.000Z");

async function mkAccount(suffix: string, label: string, isDefault: boolean) {
  return (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${S}_${suffix}`,
        label,
        isDefault,
        isActive: true,
        config: { phoneNumberId: `${S}_${suffix}` },
        secrets: {},
      },
      select: { id: true },
    })
  ).id;
}

async function mkConversation(accountId: string, phone: string) {
  const contact = await prisma.contact.create({
    data: { workspaceId, identityChannel: "whatsapp", phoneNumber: phone, name: phone },
    select: { id: true },
  });
  return (
    await prisma.conversation.create({
      data: {
        workspaceId,
        contactId: contact.id,
        channel: "whatsapp",
        channelConnectionId: accountId,
        status: "open",
        lastMessageAt: AT,
      },
      select: { id: true },
    })
  ).id;
}

/** `stampedAccountId: null` simulates a row written BEFORE the column shipped. */
async function mkMessage(o: {
  conversationId: string;
  externalId: string;
  direction: "in" | "out";
  stampedAccountId: string | null;
}) {
  await prisma.message.create({
    data: {
      workspaceId,
      conversationId: o.conversationId,
      externalId: o.externalId,
      channel: "whatsapp",
      direction: o.direction,
      body: "x",
      timestamp: AT,
      channelConnectionId: o.stampedAccountId,
    },
  });
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `RA Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `RA WS ${S}`, organizationId: orgId } })
  ).id;
  salesId = await mkAccount("sales", "Sales line", true);
  supportId = await mkAccount("support", "Support line", false);
  salesConvId = await mkConversation(salesId, `${Date.now()}`.slice(-11));
  supportConvId = await mkConversation(supportId, `${Date.now() + 1}`.slice(-11));

  // Sales: 2 in, 1 out — all STAMPED (post-migration rows).
  await mkMessage({ conversationId: salesConvId, externalId: `${S}_s1`, direction: "in", stampedAccountId: salesId });
  await mkMessage({ conversationId: salesConvId, externalId: `${S}_s2`, direction: "in", stampedAccountId: salesId });
  await mkMessage({ conversationId: salesConvId, externalId: `${S}_s3`, direction: "out", stampedAccountId: salesId });
  // Support: 1 in, 1 out — UNSTAMPED, the pre-column shape. These must still be
  // attributed, via the conversation pointer.
  await mkMessage({ conversationId: supportConvId, externalId: `${S}_p1`, direction: "in", stampedAccountId: null });
  await mkMessage({ conversationId: supportConvId, externalId: `${S}_p2`, direction: "out", stampedAccountId: null });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("scoping the whole report to one account", () => {
  it("narrows EVERY volume panel, not just the accounts breakdown", async () => {
    const all = await getWorkspaceReport(workspaceId, { from: FROM, to: TO, tz: "UTC" });
    const sales = await getWorkspaceReport(workspaceId, {
      from: FROM,
      to: TO,
      tz: "UTC",
      accountId: salesId,
    });

    // Workspace-wide sees both lines; scoped sees only Sales.
    expect(all.volume.inbound).toBe(3);
    expect(sales.volume.inbound).toBe(2);
    expect(sales.volume.outbound).toBe(1);

    // The channel panel must narrow too — otherwise "WhatsApp: 3" sits next to
    // "Sales: 2" on the same screen and the operator cannot tell which lies.
    expect(sales.channels.reduce((n, c) => n + c.inbound, 0)).toBe(2);

    // The daily series is the same volume, bucketed — it must agree.
    expect(sales.volume.daily.reduce((n, d) => n + d.inbound, 0)).toBe(2);
  });

  it("the scoped report's accounts panel contains ONLY that account", async () => {
    // The filter and the breakdown are two halves of one screen; if they used
    // different attribution rules a pre-column message would count in one and
    // vanish from the other.
    const sales = await getWorkspaceReport(workspaceId, {
      from: FROM,
      to: TO,
      tz: "UTC",
      accountId: salesId,
    });
    expect(sales.accounts.map((a) => a.accountId)).toEqual([salesId]);
  });

  it("scopes to an account whose messages are all PRE-COLUMN", async () => {
    // Support's rows carry no stamp; the filter must coalesce exactly like the
    // breakdown or this returns zero — a silent "the Support line did nothing".
    const support = await getWorkspaceReport(workspaceId, {
      from: FROM,
      to: TO,
      tz: "UTC",
      accountId: supportId,
    });
    expect(support.volume.inbound).toBe(1);
    expect(support.volume.outbound).toBe(1);
    expect(support.accounts.map((a) => a.accountId)).toEqual([supportId]);
  });

  it("scoped panels SUM to the unscoped totals", async () => {
    // The real integrity check: two scoped reports must reconstruct the whole.
    const all = await getWorkspaceReport(workspaceId, { from: FROM, to: TO, tz: "UTC" });
    const [sales, support] = await Promise.all([
      getWorkspaceReport(workspaceId, { from: FROM, to: TO, tz: "UTC", accountId: salesId }),
      getWorkspaceReport(workspaceId, { from: FROM, to: TO, tz: "UTC", accountId: supportId }),
    ]);
    expect(sales.volume.inbound + support.volume.inbound).toBe(all.volume.inbound);
    expect(sales.volume.outbound + support.volume.outbound).toBe(all.volume.outbound);
  });

  it("REFUSES an account from another workspace", async () => {
    // A foreign id would have matched nothing (every query carries workspaceId
    // independently), and an empty report reads as "that line did no work" —
    // indistinguishable from the truth. Fail loudly instead.
    const otherOrg = await prisma.organization.create({
      data: { name: `RA Other ${S}`, status: "active" },
      select: { id: true },
    });
    const otherWs = await prisma.workspace.create({
      data: { name: `RA Other WS ${S}`, organizationId: otherOrg.id },
      select: { id: true },
    });
    const foreign = await prisma.channelConnection.create({
      data: {
        workspaceId: otherWs.id,
        channel: "whatsapp",
        externalAccountId: `${S}_foreign`,
        isDefault: true,
        isActive: true,
        config: {},
        secrets: {},
      },
      select: { id: true },
    });

    await expect(
      getWorkspaceReport(workspaceId, {
        from: FROM,
        to: TO,
        tz: "UTC",
        accountId: foreign.id,
      }),
    ).rejects.toThrow(/unknown channel account/);

    await prisma.organization.delete({ where: { id: otherOrg.id } }).catch(() => undefined);
  });

  it("echoes the scope back on the range", async () => {
    const scoped = await getWorkspaceReport(workspaceId, {
      from: FROM,
      to: TO,
      tz: "UTC",
      accountId: salesId,
    });
    const all = await getWorkspaceReport(workspaceId, { from: FROM, to: TO, tz: "UTC" });
    expect(scoped.range.accountId).toBe(salesId);
    expect(all.range.accountId).toBeNull();
  });
});

describe("report accounts panel", () => {
  it("splits volume by ACCOUNT, not just by channel", async () => {
    const report = await getWorkspaceReport(workspaceId, { from: FROM, to: TO, tz: "UTC" });

    // The channel panel sees one bucket — which is exactly the blind spot.
    expect(report.channels).toHaveLength(1);
    expect(report.channels[0]!.channel).toBe("whatsapp");
    expect(report.channels[0]!.inbound).toBe(3);

    // The account panel sees two.
    const byId = new Map(report.accounts.map((a) => [a.accountId, a]));
    expect(byId.get(salesId)).toMatchObject({ inbound: 2, outbound: 1 });
    expect(byId.get(supportId)).toMatchObject({ inbound: 1, outbound: 1 });
  });

  it("attributes PRE-COLUMN messages via the conversation pointer", async () => {
    // Support's rows carry no stamp at all. Without the COALESCE they would
    // collapse into a single `null` bucket — every message older than the
    // migration reported as "unattributed", which would make the panel
    // useless on exactly the historical ranges people run reports over.
    const report = await getWorkspaceReport(workspaceId, { from: FROM, to: TO, tz: "UTC" });
    const support = report.accounts.find((a) => a.accountId === supportId);
    expect(support, "unstamped messages were not attributed").toBeTruthy();
    expect(support!.inbound + support!.outbound).toBe(2);
    expect(report.accounts.some((a) => a.accountId === null)).toBe(false);
  });

  it("names each account for a human", async () => {
    const report = await getWorkspaceReport(workspaceId, { from: FROM, to: TO, tz: "UTC" });
    const names = report.accounts.map((a) => a.name);
    expect(names).toContain("Sales line");
    expect(names).toContain("Support line");
  });

  it("totals reconcile with the channel panel", async () => {
    // A breakdown that doesn't add up to the headline is worse than no
    // breakdown — the operator can't tell which number is lying.
    const report = await getWorkspaceReport(workspaceId, { from: FROM, to: TO, tz: "UTC" });
    const accIn = report.accounts.reduce((n, a) => n + a.inbound, 0);
    const accOut = report.accounts.reduce((n, a) => n + a.outbound, 0);
    const chIn = report.channels.reduce((n, c) => n + c.inbound, 0);
    const chOut = report.channels.reduce((n, c) => n + c.outbound, 0);
    expect(accIn).toBe(chIn);
    expect(accOut).toBe(chOut);
  });

  it("reports traffic whose account is GONE rather than dropping it", async () => {
    // `onDelete: SetNull` fallout from a disconnected number. Silently omitting
    // it would make the totals stop reconciling with no visible cause.
    const orphanConv = await mkConversation(salesId, `${Date.now() + 2}`.slice(-11));
    await mkMessage({
      conversationId: orphanConv,
      externalId: `${S}_orphan`,
      direction: "in",
      stampedAccountId: null,
    });
    await prisma.conversation.update({
      where: { id: orphanConv },
      data: { channelConnectionId: null },
    });

    const report = await getWorkspaceReport(workspaceId, { from: FROM, to: TO, tz: "UTC" });
    const unattributed = report.accounts.find((a) => a.accountId === null);
    expect(unattributed, "orphaned traffic was dropped from the report").toBeTruthy();
    expect(unattributed!.inbound).toBe(1);

    // Still reconciles.
    const accIn = report.accounts.reduce((n, a) => n + a.inbound, 0);
    const chIn = report.channels.reduce((n, c) => n + c.inbound, 0);
    expect(accIn).toBe(chIn);
  });
});
