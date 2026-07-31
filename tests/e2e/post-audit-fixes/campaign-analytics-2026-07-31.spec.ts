/**
 * CAMPAIGN ANALYTICS, END TO END — the rollup, the pages, and the loop.
 *
 * Seeds one campaign of TWO sends (WhatsApp + Messenger) whose recipients span
 * the whole funnel — read/replied, delivered/clicked, undelivered, failed at
 * send, opted out — with per-recipient sending-account stamps (one live-ish,
 * one pointing at a deleted account), Meta pricing lines, and an ad-attributed
 * contact. Then walks everything built on top of it:
 *
 *   API   /api/reports/campaigns            — the index lists it
 *   API   /api/reports/campaigns/:name      — funnel + all five cuts, exact
 *   API   /api/reports/acquisition          — the ad row + organic split
 *   API   /api/contacts/:id/acquisition     — the per-contact "came from"
 *   UI    /reports                          — acquisition panel + Campaigns card
 *   UI    /reports/campaigns                — index row
 *   UI    /reports/campaigns/<name>         — stats, by-send, by-account,
 *                                             failures, cost, sources
 *   UI    /broadcasts/<id>                  — campaign chip → rollup page
 *   UI    /broadcasts/new?from=<id>         — Duplicate carries the campaign
 *
 * The maths asserted here is the load-bearing part: a person reached by BOTH
 * sends counts once in contactsReached, rates come from summed counts (never
 * averaged per-send rates), a disconnected account's recipients are reported
 * rather than dropped, and unpriced (failed) recipients stay out of the cost
 * table.
 *
 * SAFE / self-cleaning: seeds under the e2e app-admin workspace with an
 * `e2e_camp_` prefix and deletes only that. Does NOT call wipeTestData.
 */
import { test, expect } from "@playwright/test";

import { db, appAdmin } from "../_helpers/db";

test.describe.configure({ mode: "serial" });

const PREFIX = "e2e_camp_";
const CAMPAIGN = `${PREFIX}Spring Sale`;
/** Stamped on a recipient but never created — the disconnected-account case. */
const GONE_ACCOUNT = `${PREFIX}gone`;

let workspaceId = "";
let waBroadcastId = "";
let fbBroadcastId = "";
let adContactId = "";

async function contact(n: number, name: string): Promise<string> {
  return (
    await db().contact.create({
      data: {
        workspaceId,
        name: `${PREFIX}${name}`,
        phoneNumber: `+1555${String(9100000 + n).slice(0, 7)}`,
        identityChannel: "whatsapp",
        source: "manual",
      },
      select: { id: true },
    })
  ).id;
}

test.beforeAll(async () => {
  workspaceId = (await appAdmin()).workspaceId;

  // The composer pre-flight bounces to /settings/whatsapp when the workspace
  // has no active account on the channel it opens on — correct product
  // behavior that the Duplicate test would otherwise trip over, since the e2e
  // workspace connects nothing. Seed a minimal inactive-credentials connection
  // (prefixed externalAccountId so it can't P2002 another spec's fixture, and
  // so cleanup can find it).
  await db().channelConnection.upsert({
    where: {
      workspaceId_channel_externalAccountId: {
        workspaceId,
        channel: "whatsapp",
        externalAccountId: `${PREFIX}pn`,
      },
    },
    create: {
      workspaceId,
      channel: "whatsapp",
      externalAccountId: `${PREFIX}pn`,
      label: `${PREFIX}number`,
      config: { phoneNumberId: `${PREFIX}pn` },
      secrets: {},
      isActive: true,
    },
    update: { isActive: true },
  });

  // ── The campaign: two sends under one name ────────────────────────────────
  waBroadcastId = (
    await db().broadcast.create({
      data: {
        workspaceId,
        name: `${PREFIX}First send`,
        campaignName: CAMPAIGN,
        status: "completed",
        kind: "template",
        targetMode: "contact",
        channel: "whatsapp",
        templateName: `${PREFIX}promo`,
        templateLanguage: "en",
        variables: { body: [] },
        audienceMode: "all",
        totalCount: 3,
        sentCount: 2,
        failedCount: 1,
        startedAt: new Date(Date.now() - 120_000),
        completedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;
  fbBroadcastId = (
    await db().broadcast.create({
      data: {
        workspaceId,
        name: `${PREFIX}Re-send`,
        campaignName: CAMPAIGN,
        status: "completed",
        kind: "freeform",
        targetMode: "contact",
        channel: "messenger",
        bodyText: "One more day of the sale",
        variables: { body: [] },
        audienceMode: "all",
        totalCount: 2,
        sentCount: 1,
        failedCount: 1,
        startedAt: new Date(Date.now() - 60_000),
        completedAt: new Date(),
      },
      select: { id: true },
    })
  ).id;

  // ── Recipients: the whole funnel, in exact known quantities ───────────────
  // WhatsApp send: read+replied (priced, billable) / delivered+opted-out /
  // undelivered (24h window).
  adContactId = await contact(0, "ad_read");
  const c1 = await contact(1, "delivered");
  const c2 = await contact(2, "window");
  // Messenger send: the SAME person as the read one (dedupe pin) clicked, plus
  // a failure from an account that no longer exists.
  const c3 = await contact(3, "gone_fail");

  await db().broadcastRecipient.createMany({
    data: [
      {
        broadcastId: waBroadcastId,
        contactId: adContactId,
        status: "sent",
        deliveryState: "read",
        sentAt: new Date(),
        deliveredAt: new Date(),
        readAt: new Date(),
        repliedAt: new Date(),
        pricingCategory: "marketing",
        pricingType: "regular",
        pricingBillable: true,
      },
      {
        broadcastId: waBroadcastId,
        contactId: c1,
        status: "sent",
        deliveryState: "delivered",
        sentAt: new Date(),
        deliveredAt: new Date(),
        optedOutAt: new Date(),
        pricingCategory: "utility",
        pricingType: "free_customer_service",
        pricingBillable: false,
      },
      {
        broadcastId: waBroadcastId,
        contactId: c2,
        status: "failed",
        deliveryState: "undelivered",
        errorCode: "outside_24h_window",
        metaErrorCode: 131047,
        errorMessage: "outside_24h_window: seeded",
      },
      {
        broadcastId: fbBroadcastId,
        contactId: adContactId,
        status: "sent",
        deliveryState: "delivered",
        sentAt: new Date(),
        deliveredAt: new Date(),
        clickedAt: new Date(),
      },
      {
        broadcastId: fbBroadcastId,
        contactId: c3,
        status: "failed",
        deliveryState: "failed_at_send",
        channelConnectionId: GONE_ACCOUNT,
        errorCode: "app_permission_required",
        metaErrorCode: 200,
        errorMessage: "app_permission_required: seeded",
      },
    ],
  });

  // ── Acquisition: the read contact originally arrived from an ad ───────────
  const conv = await db().conversation.create({
    data: { workspaceId, contactId: adContactId, channel: "whatsapp" },
    select: { id: true },
  });
  await db().message.create({
    data: {
      workspaceId,
      conversationId: conv.id,
      channel: "whatsapp",
      direction: "in",
      externalId: `${PREFIX}wamid_ad_1`,
      body: "hi, saw your ad",
      timestamp: new Date("2026-03-01T10:00:00Z"),
      attribution: { source: "ad", adId: `${PREFIX}AD_1`, headline: `${PREFIX}creative` },
    },
  });
});

test.afterAll(async () => {
  const rows = await db().broadcast.findMany({
    where: { workspaceId, campaignName: CAMPAIGN },
    select: { id: true },
  });
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await db().broadcastRecipient.deleteMany({ where: { broadcastId: { in: ids } } });
    await db().broadcast.deleteMany({ where: { id: { in: ids } } });
  }
  await db().message.deleteMany({
    where: { workspaceId, externalId: { startsWith: PREFIX } },
  });
  const contacts = await db().contact.findMany({
    where: { workspaceId, name: { startsWith: PREFIX } },
    select: { id: true },
  });
  await db().conversation.deleteMany({
    where: { workspaceId, contactId: { in: contacts.map((c) => c.id) } },
  });
  await db().contact.deleteMany({
    where: { workspaceId, id: { in: contacts.map((c) => c.id) } },
  });
  await db().channelConnection.deleteMany({
    where: { workspaceId, externalAccountId: { startsWith: PREFIX } },
  });
  await db().$disconnect();
});

// ---------------------------------------------------------------------------
// API — the numbers, exact
// ---------------------------------------------------------------------------

test("campaign index lists the campaign with its send count", async ({ page }) => {
  await page.goto("/reports");
  const res = await page.request.get("/api/reports/campaigns");
  if (!res.ok()) throw new Error(`campaigns ${res.status()}: ${await res.text()}`);
  const { campaigns } = (await res.json()) as {
    campaigns: Array<{ campaignName: string; broadcasts: number; lastSentAt: string | null }>;
  };
  const row = campaigns.find((c) => c.campaignName === CAMPAIGN);
  expect(row, "seeded campaign missing from the index").toBeTruthy();
  expect(row!.broadcasts).toBe(2);
  expect(row!.lastSentAt).not.toBeNull();
});

test("rollup: funnel, distinct people, per-send, per-account, failures, cost, sources", async ({
  page,
}) => {
  await page.goto("/reports");
  const res = await page.request.get(
    `/api/reports/campaigns/${encodeURIComponent(CAMPAIGN)}`,
  );
  if (!res.ok()) throw new Error(`rollup ${res.status()}: ${await res.text()}`);
  const r = (await res.json()) as Record<string, never> & any;

  // Funnel, summed across both sends.
  expect(r.targeted).toBe(5);
  expect(r.reached).toBe(3); // read + delivered + delivered
  expect(r.read).toBe(1);
  expect(r.failed).toBe(2); // undelivered + failed_at_send
  expect(r.replied).toBe(1);
  expect(r.clicked).toBe(1);
  expect(r.optedOut).toBe(1);
  // The ad contact was reached by BOTH sends — one person, not two.
  expect(r.contactsReached).toBe(2);
  // Rates from summed counts: 3/5 and 1/3.
  expect(r.deliveryRate).toBeCloseTo(3 / 5, 5);
  expect(r.readRate).toBeCloseTo(1 / 3, 5);

  // Per send, each with its own funnel, newest first.
  expect(r.broadcasts.map((b: { id: string }) => b.id)).toEqual([fbBroadcastId, waBroadcastId]);
  const wa = r.broadcasts.find((b: { id: string }) => b.id === waBroadcastId)!;
  expect(wa.funnel).toMatchObject({ targeted: 3, reached: 2, read: 1, failed: 1, replied: 1 });

  // Per account: the disconnected stamp is REPORTED, not dropped, and the
  // account rows still sum to the campaign total.
  const gone = r.accounts.find((a: { accountId: string | null }) => a.accountId === GONE_ACCOUNT);
  expect(gone, "disconnected account row missing").toBeTruthy();
  expect(gone.deleted).toBe(true);
  expect(gone.funnel.failed).toBe(1);
  const summed = r.accounts.reduce(
    (n: number, a: { funnel: { targeted: number } }) => n + a.funnel.targeted,
    0,
  );
  expect(summed).toBe(r.targeted);

  // Failures share the send path's vocabulary and carry Meta's raw code.
  const window = r.failures.find((f: { code: string }) => f.code === "outside_24h_window")!;
  expect(window.count).toBe(1);
  expect(window.label).toBe("Messaging window closed");
  expect(window.metaCode).toBe(131047);

  // Cost: only the two priced recipients — a failed row carries no pricing and
  // must not appear as a (null, null) line.
  expect(
    r.cost.reduce((n: number, c: { count: number }) => n + c.count, 0),
  ).toBe(2);
  const free = r.cost.find(
    (c: { type: string | null }) => c.type === "free_customer_service",
  )!;
  expect(free.billable).toBe(false);

  // Sources: the reached people's original acquisition.
  const src = r.sources.find(
    (s2: { sourceId: string | null }) => s2.sourceId === `${PREFIX}AD_1`,
  )!;
  expect(src, "ad source missing from the rollup").toBeTruthy();
  expect(src.contacts).toBe(1);
});

test("acquisition report carries the ad row; per-contact endpoint answers 'came from'", async ({
  page,
}) => {
  await page.goto("/reports");

  const agg = await page.request.get("/api/reports/acquisition");
  if (!agg.ok()) throw new Error(`acquisition ${agg.status()}: ${await agg.text()}`);
  const report = (await agg.json()) as {
    rows: Array<{ source: string; sourceId: string | null; contacts: number }>;
    organic: number;
  };
  const ad = report.rows.find((x) => x.sourceId === `${PREFIX}AD_1`);
  expect(ad, "seeded ad missing from acquisition rows").toBeTruthy();
  expect(ad!.source).toBe("ad");
  expect(ad!.contacts).toBe(1);
  // Not asserting an exact organic figure — the shared dev workspace holds an
  // unknown number of real directory contacts. The DB-backed vitest spec pins
  // the exact split (incl. the ephemeral-visitor exclusion) on isolated data.
  expect(report.organic).toBeGreaterThanOrEqual(0);

  const one = await page.request.get(`/api/contacts/${adContactId}/acquisition`);
  if (!one.ok()) throw new Error(`contact acquisition ${one.status()}: ${await one.text()}`);
  const { acquisition } = (await one.json()) as { acquisition: Record<string, unknown> | null };
  expect(acquisition).toMatchObject({
    source: "ad",
    adId: `${PREFIX}AD_1`,
    headline: `${PREFIX}creative`,
  });

  // An organic contact answers null — NOT a 404, which would be
  // indistinguishable from "no such contact".
  const organicContact = await db().contact.findFirst({
    where: { workspaceId, name: `${PREFIX}delivered` },
    select: { id: true },
  });
  const two = await page.request.get(`/api/contacts/${organicContact!.id}/acquisition`);
  expect(two.status()).toBe(200);
  expect(((await two.json()) as { acquisition: unknown }).acquisition).toBeNull();
});

// ---------------------------------------------------------------------------
// UI — every surface renders the same truth
// ---------------------------------------------------------------------------

test("reports dashboard shows the acquisition panel and the Campaigns card", async ({
  page,
}) => {
  await page.goto("/reports");
  await expect(page.getByText("Where customers came from")).toBeVisible({ timeout: 30_000 });
  // The seeded ad renders as a table row with its raw id (what you paste into
  // Ads Manager).
  await expect(page.getByText(`${PREFIX}AD_1`)).toBeVisible();
  await expect(page.getByText(`${PREFIX}creative`)).toBeVisible();
  // The card that makes the campaigns pages findable.
  const card = page.getByRole("link", { name: /Campaigns/ });
  await expect(card.first()).toBeVisible();
});

test("campaigns index → campaign page: stats and all four breakdown panels", async ({
  page,
}) => {
  await page.goto("/reports/campaigns");
  const row = page.getByRole("link", { name: new RegExp(CAMPAIGN) });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("2 sends")).toBeVisible();

  await row.click();
  await expect(page).toHaveURL(new RegExp("/reports/campaigns/"));

  // Headline stats.
  await expect(page.getByRole("heading", { name: CAMPAIGN })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("2 sends · 2 people reached")).toBeVisible();

  // By send — both rows, linking back to the broadcasts. Heading role +
  // exact, because "By sending account" CONTAINS "By send" and a bare text
  // locator strict-fails on the pair.
  await expect(page.getByRole("heading", { name: "By send", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `${PREFIX}First send` })).toBeVisible();
  await expect(page.getByRole("link", { name: `${PREFIX}Re-send` })).toBeVisible();

  // By account — the disconnected stamp is on screen, labeled as what it is.
  await expect(page.getByRole("heading", { name: "By sending account" })).toBeVisible();
  await expect(page.getByText("Disconnected account")).toBeVisible();

  // Failures — human label + Meta's raw code.
  await expect(page.getByRole("heading", { name: "Why messages failed" })).toBeVisible();
  await expect(page.getByText("Messaging window closed")).toBeVisible();
  await expect(page.getByText(/Meta 131047/)).toBeVisible();

  // Cost — the free service-window line is explained, not just flagged.
  await expect(page.getByRole("heading", { name: "What Meta charged for" })).toBeVisible();
  await expect(page.getByText("Free — inside the customer's service window")).toBeVisible();

  // Sources — where the reached people originally came from.
  await expect(page.getByRole("heading", { name: "Where the people you reached came from" })).toBeVisible();
  await expect(page.getByText(`${PREFIX}AD_1`)).toBeVisible();
});

test("broadcast detail links to its campaign; Duplicate carries the campaign name", async ({
  page,
}) => {
  await page.goto(`/broadcasts/${waBroadcastId}`);
  const chip = page.getByRole("link", { name: `Campaign: ${CAMPAIGN}` });
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await chip.click();
  await expect(page.getByRole("heading", { name: CAMPAIGN })).toBeVisible({ timeout: 30_000 });

  // Duplicate IS the campaign's next send — the composer must open with the
  // campaign already filled, or every re-send silently starts a campaign of one.
  await page.goto(`/broadcasts/new?from=${waBroadcastId}`);
  const campaignInput = page.getByPlaceholder("e.g. Spring Sale");
  await expect(campaignInput).toBeVisible({ timeout: 30_000 });
  await expect(campaignInput).toHaveValue(CAMPAIGN);
});
