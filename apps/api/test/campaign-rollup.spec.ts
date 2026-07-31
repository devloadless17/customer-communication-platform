/**
 * Campaign rollup — several broadcasts read as one set of numbers.
 *
 * Drives the real aggregate against a real database, because every claim the
 * rollup makes is a SQL claim: whether a person in two sends is counted once,
 * whether the account rows still add up when one account has been disconnected,
 * whether a rate is computed from summed counts or averaged from per-send rates.
 * None of those survive a mocked query.
 *
 * The specific regressions pinned here, each of which was real:
 *
 *   - `contactsReached` counted messages, so a campaign could report reaching
 *     more people than the workspace has.
 *   - a `ChannelConnection.label` defaults to EMPTY STRING, not null, so the
 *     nullish fallback chain picked it up and a live Page rendered as a blank
 *     row in the by-account table. Found on the first run against real data.
 *   - a recipient stamped with an account that was later disconnected must be
 *     REPORTED (as disconnected), not dropped — dropping it makes the account
 *     rows quietly stop summing to the campaign total.
 *
 *   pnpm --filter @ccp/api exec vitest run test/campaign-rollup.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setSharedDb } from "@/lib/db";
import { campaignRollup, listCampaigns } from "@/lib/analytics/campaign-rollup";

import { createTestPrismaClient } from "./_prisma";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = createTestPrismaClient();
setSharedDb(prisma as unknown as PrismaClient);

const S = `cr${Date.now().toString().slice(-8)}`;
const CAMPAIGN = `Spring sale ${S}`;

let orgId = "";
let workspaceId = "";
let blankLabelAccount = "";
/** Never created as a row — the "account was disconnected" stamp. */
const GONE_ACCOUNT = `${S}_gone`;
const contactIds: string[] = [];
let waBroadcast = "";
let fbBroadcast = "";

async function broadcast(channel: "whatsapp" | "messenger", name: string) {
  return (
    await prisma.broadcast.create({
      data: {
        workspaceId,
        name,
        campaignName: CAMPAIGN,
        channel,
        kind: "template",
        status: "completed",
        variables: {},
        audienceMode: "all",
      },
      select: { id: true },
    })
  ).id;
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({ data: { name: `CR Org ${S}`, status: "active" } })
  ).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `CR WS ${S}`, organizationId: orgId } })
  ).id;

  // `label` left at its EMPTY-STRING default on purpose — this is the account
  // whose row used to render blank.
  blankLabelAccount = (
    await prisma.channelConnection.create({
      data: {
        workspaceId,
        channel: "messenger",
        externalAccountId: `${S}_page`,
        verifiedName: "Lucky Shrub Support",
        config: {},
        secrets: {},
      },
      select: { id: true },
    })
  ).id;

  for (let i = 0; i < 4; i++) {
    contactIds.push(
      (
        await prisma.contact.create({
          data: {
            workspaceId,
            name: `CR ${i}`,
            phoneNumber: `+98${S}${String(i).padStart(3, "0")}`,
            identityChannel: "whatsapp",
          },
          select: { id: true },
        })
      ).id,
    );
  }

  waBroadcast = await broadcast("whatsapp", "First send");
  fbBroadcast = await broadcast("messenger", "Re-send to non-openers");

  await prisma.broadcastRecipient.createMany({
    data: [
      // ── WhatsApp send: 2 targeted, 1 read (and replied), 1 undelivered ────
      {
        broadcastId: waBroadcast,
        contactId: contactIds[0]!,
        status: "sent",
        deliveryState: "read",
        readAt: new Date(),
        repliedAt: new Date(),
        pricingCategory: "marketing",
        pricingType: "regular",
        pricingBillable: true,
      },
      {
        broadcastId: waBroadcast,
        contactId: contactIds[1]!,
        status: "failed",
        deliveryState: "undelivered",
        errorCode: "outside_24h_window",
        metaErrorCode: 131047,
      },
      // ── Messenger send: the SAME person as above, plus one failure from an
      //    account that no longer exists ──────────────────────────────────────
      {
        broadcastId: fbBroadcast,
        contactId: contactIds[0]!,
        status: "sent",
        deliveryState: "delivered",
        channelConnectionId: blankLabelAccount,
        clickedAt: new Date(),
        optedOutAt: new Date(),
        // Priced, and priced FREE — the service-window case that makes a mixed
        // billable column explicable rather than looking like our bug.
        pricingCategory: "utility",
        pricingType: "free_customer_service",
        pricingBillable: false,
      },
      {
        broadcastId: fbBroadcast,
        contactId: contactIds[2]!,
        status: "failed",
        deliveryState: "failed_at_send",
        channelConnectionId: GONE_ACCOUNT,
        errorCode: "app_permission_required",
        metaErrorCode: 200,
      },
    ],
  });
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe("campaign totals", () => {
  it("sums the funnel across every send in the campaign", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    expect(r).not.toBeNull();
    expect(r.targeted).toBe(4);
    expect(r.reached).toBe(2); // one read + one delivered
    expect(r.read).toBe(1);
    expect(r.failed).toBe(2); // undelivered + failed_at_send
    expect(r.replied).toBe(1);
    expect(r.clicked).toBe(1);
    expect(r.optedOut).toBe(1);
  });

  it("counts a person reached by TWO sends once", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    // Contact 0 was reached by both the WhatsApp and the Messenger send. Two
    // recipient rows, ONE person — summing per-broadcast reach would say 2 and
    // report the campaign as having reached more people than it did.
    expect(r.reached).toBe(2);
    expect(r.contactsReached).toBe(1);
  });

  it("computes rates from summed counts, not by averaging per-send rates", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    // Per-send delivery is 50% and 50%, so averaging happens to agree here —
    // what this pins is the DENOMINATOR: reached/targeted over the whole
    // campaign, and read/REACHED (not read/targeted) for the read rate.
    expect(r.deliveryRate).toBeCloseTo(2 / 4);
    expect(r.readRate).toBeCloseTo(1 / 2);
  });

  it("returns null for a campaign name nobody used", async () => {
    expect(await campaignRollup(workspaceId, `${CAMPAIGN} (no such thing)`)).toBeNull();
  });
});

describe("per-send breakdown", () => {
  it("gives each send its own funnel, newest first", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    expect(r.broadcasts.map((b) => b.id)).toEqual([fbBroadcast, waBroadcast]);
    const fb = r.broadcasts.find((b) => b.id === fbBroadcast)!;
    expect(fb.funnel).toMatchObject({ targeted: 2, reached: 1, read: 0, failed: 1, clicked: 1 });
    const wa = r.broadcasts.find((b) => b.id === waBroadcast)!;
    expect(wa.funnel).toMatchObject({ targeted: 2, reached: 1, read: 1, failed: 1, replied: 1 });
  });

  it("adds up to the campaign total", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    const summed = r.broadcasts.reduce((n, b) => n + b.funnel.targeted, 0);
    expect(summed).toBe(r.targeted);
  });
});

describe("per-account breakdown", () => {
  it("never labels a live account with an empty string", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    const row = r.accounts.find((a) => a.accountId === blankLabelAccount)!;
    expect(row).toBeDefined();
    // `label` is "" in the database, so a `??` chain would return "" here and
    // the table would render a nameless row.
    expect(row.label).toBe("Lucky Shrub Support");
    expect(row.deleted).toBe(false);
    expect(row.channel).toBe("messenger");
  });

  it("reports a disconnected account rather than dropping its recipients", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    const gone = r.accounts.find((a) => a.accountId === GONE_ACCOUNT)!;
    expect(gone).toBeDefined();
    expect(gone.deleted).toBe(true);
    expect(gone.funnel.failed).toBe(1);
    // And the rows still account for every recipient — the property that makes
    // this table trustworthy at all.
    const summed = r.accounts.reduce((n, a) => n + a.funnel.targeted, 0);
    expect(summed).toBe(r.targeted);
  });

  it("groups the un-stamped recipients under the campaign's own account", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    const own = r.accounts.find((a) => a.accountId === null)!;
    // Both WhatsApp recipients: a phone number is not identity-scoped, so the
    // runner never stamps one.
    expect(own.funnel.targeted).toBe(2);
    expect(own.deleted).toBe(false);
  });

  it("sorts the biggest sender first", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    const targeted = r.accounts.map((a) => a.funnel.targeted);
    expect([...targeted].sort((a, b) => b - a)).toEqual(targeted);
  });
});

describe("failures", () => {
  it("carries the send path's own label and bucket, not a second vocabulary", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    const window = r.failures.find((f) => f.code === "outside_24h_window")!;
    expect(window.count).toBe(1);
    expect(window.label).toBe("Messaging window closed");
    // Meta's raw code travels alongside — it is what you quote to Meta support.
    expect(window.metaCode).toBe(131047);
    expect(window.bucket).toBeTruthy();

    const perm = r.failures.find((f) => f.code === "app_permission_required")!;
    expect(perm.metaCode).toBe(200);
  });

  it("counts only recipients that actually carry a code", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    const total = r.failures.reduce((n, f) => n + f.count, 0);
    expect(total).toBe(r.failed);
  });
});

describe("cost", () => {
  it("reports Meta's pricing lines and excludes recipients Meta never priced", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    // Two of the four recipients failed and carry no pricing block at all. A
    // (null, null, null) line at the top of the cost table would read as "we
    // could not price most of this campaign".
    expect(r.cost.reduce((n, c) => n + c.count, 0)).toBe(2);
    expect(r.cost).toEqual(
      expect.arrayContaining([
        { category: "marketing", type: "regular", billable: true, count: 1 },
        {
          category: "utility",
          type: "free_customer_service",
          billable: false,
          count: 1,
        },
      ]),
    );
  });

  it("carries no currency amount", async () => {
    const r = (await campaignRollup(workspaceId, CAMPAIGN))!;
    // Meta sends a category and a billable flag, never a price. Storing a
    // computed amount would freeze a stale per-country rate card into the audit
    // trail, so the rollup must never grow one.
    for (const line of r.cost) {
      expect(Object.keys(line).sort()).toEqual(["billable", "category", "count", "type"]);
    }
  });
});

describe("listCampaigns", () => {
  it("finds the campaign with its send count", async () => {
    const rows = await listCampaigns(workspaceId);
    const row = rows.find((c) => c.campaignName === CAMPAIGN)!;
    expect(row).toBeDefined();
    expect(row.broadcasts).toBe(2);
    expect(row.lastSentAt).not.toBeNull();
  });
});
