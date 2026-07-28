/**
 * Meta template analytics — the parser and the daily rollup.
 *
 * One property carries almost all the risk here: **a captured metric must never
 * be overwritten by a later null OR zero.**
 *
 * Meta reports READ and CLICKED only for the last ~7 days — then RESETS them
 * to zero (its Analytics doc says so explicitly) — and withholds COST entirely
 * for Solution-Partner-billed WABAs. So re-fetching a three-week-old campaign
 * legitimately returns nulls and 0s for numbers we captured correctly at the
 * time. A naive upsert would zero out good history on every refresh — and the
 * damage is permanent and silent, because the source can no longer produce
 * those numbers. That is what the GREATEST/COALESCE merge exists for, and what
 * most of this file tests.
 *
 * The parser gets the same discipline: an absent metric is `null`, never 0,
 * because "we don't know" and "nobody read it" are different answers.
 *
 *   pnpm --filter @ccp/api exec vitest run test/template-analytics.spec.ts
 */
import { existsSync } from "node:fs";

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseTemplateAnalytics } from "@/lib/providers/meta";
import { readTemplateAnalytics } from "@/lib/analytics/template-analytics";
import { setSharedDb } from "@/lib/db";

if (existsSync(".env")) process.loadEnvFile(".env");
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const S = `ta${Date.now().toString().slice(-8)}`;
let orgId = "";
let workspaceId = "";
const TPL = `tpl_${S}`;

beforeAll(async () => {
  setSharedDb(prisma as unknown as Parameters<typeof setSharedDb>[0]);
  orgId = (await prisma.organization.create({ data: { name: `TA Org ${S}`, status: "active" } })).id;
  workspaceId = (
    await prisma.workspace.create({ data: { name: `TA ws ${S}`, organizationId: orgId } })
  ).id;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

describe("parseTemplateAnalytics", () => {
  const point = (over: Record<string, unknown> = {}) => ({
    template_id: TPL,
    start: 1_760_000_000,
    sent: 100,
    delivered: 95,
    ...over,
  });

  it("reads BOTH wire shapes Meta uses", () => {
    // `{ data: [...] }` and a bare array both occur. Guessing one wrong yields
    // an empty result that is indistinguishable from "sent nothing".
    const nested = parseTemplateAnalytics({
      template_analytics: { data: [{ data_points: [point()] }] },
    });
    const bare = parseTemplateAnalytics({
      template_analytics: [{ data_points: [point()] }],
    });
    expect(nested).toHaveLength(1);
    expect(bare).toHaveLength(1);
    expect(nested[0]!.sent).toBe(100);
  });

  it("maps an ABSENT read/click to null, never to zero", () => {
    const [row] = parseTemplateAnalytics({
      template_analytics: [{ data_points: [point()] }],
    });
    // Outside Meta's 7-day window these are simply not reported. Zero would
    // assert "nobody read it", which is a different — and wrong — claim.
    expect(row!.read).toBeNull();
    expect(row!.clicked).toBeNull();
    expect(row!.clickedButtons).toBeNull();
    expect(row!.costAmountSpent).toBeNull();
  });

  it("keeps a reported ZERO as zero", () => {
    // The mirror of the case above: an explicit 0 is a real measurement.
    const [row] = parseTemplateAnalytics({
      template_analytics: [{ data_points: [point({ read: 0, clicked: 0 })] }],
    });
    expect(row!.read).toBe(0);
    expect(row!.clicked).toBe(0);
  });

  it("pulls the three cost types out of Meta's typed array — doc-example lowercase", () => {
    // Meta's Analytics doc example returns `amount_spent`, not `AMOUNT_SPENT`.
    // The parser matched only uppercase for months and every cost figure came
    // out null — this fixture is copied from the doc so that can't recur.
    const [row] = parseTemplateAnalytics({
      template_analytics: [
        {
          data_points: [
            point({
              cost: [
                { type: "amount_spent", value: 12.5, currency: "USD" },
                { type: "cost_per_delivered", value: 0.13, currency: "USD" },
                { type: "cost_per_url_button_click", value: 0.9, currency: "USD" },
              ],
            }),
          ],
        },
      ],
    });
    expect(row!.costAmountSpent).toBe(12.5);
    expect(row!.costPerDelivered).toBe(0.13);
    expect(row!.costPerUrlClick).toBe(0.9);
    expect(row!.currency).toBe("USD");
  });

  it("accepts UPPERCASE cost types too — the case must never matter", () => {
    const [row] = parseTemplateAnalytics({
      template_analytics: [
        {
          data_points: [
            point({ cost: [{ type: "AMOUNT_SPENT", value: 3.2, currency: "EUR" }] }),
          ],
        },
      ],
    });
    expect(row!.costAmountSpent).toBe(3.2);
    expect(row!.currency).toBe("EUR");
  });

  it("parses `clicked` as Meta's per-button ARRAY, scalar = link clicks only", () => {
    // Straight from the doc's example response. `clicked` is an array of
    // {type, button_content, count} — treating it as a number parsed every
    // buttoned template's clicks to null. The scalar we keep is LINK clicks
    // (unique URL-button clicks) — quick-reply presses arrive as inbound
    // replies and the funnel already counts them.
    const [row] = parseTemplateAnalytics({
      template_analytics: [
        {
          data_points: [
            point({
              clicked: [
                { type: "quick_reply_button", button_content: "Contact Support", count: 108 },
                { type: "unique_url_button", button_content: "Tell me more", count: 16 },
              ],
            }),
          ],
        },
      ],
    });
    expect(row!.clicked).toBe(16);
    expect(row!.clickedButtons).toEqual([
      { type: "quick_reply_button", buttonContent: "Contact Support", count: 108 },
      { type: "unique_url_button", buttonContent: "Tell me more", count: 16 },
    ]);
  });

  it("falls back to total url_button clicks when no unique entry is reported", () => {
    const [row] = parseTemplateAnalytics({
      template_analytics: [
        {
          data_points: [
            point({
              clicked: [{ type: "url_button", button_content: "Shop now", count: 40 }],
            }),
          ],
        },
      ],
    });
    expect(row!.clicked).toBe(40);
  });

  it("still tolerates a plain scalar `clicked`", () => {
    // The shape this parser originally assumed; keep accepting it.
    const [row] = parseTemplateAnalytics({
      template_analytics: [{ data_points: [point({ clicked: 7 })] }],
    });
    expect(row!.clicked).toBe(7);
    expect(row!.clickedButtons).toBeNull();
  });

  it("maps an all-zero breakdown to a null breakdown but a ZERO scalar", () => {
    // All-zero is ambiguous: a campaign nobody clicked, or Meta's post-7-day
    // reset (the doc says counts "reset to zero"). The breakdown goes to null
    // so the COALESCE merge can't erase a captured one; the scalar stays 0 and
    // the GREATEST merge keeps a captured higher value either way.
    const [row] = parseTemplateAnalytics({
      template_analytics: [
        {
          data_points: [
            point({
              clicked: [{ type: "unique_url_button", button_content: "Tell me more", count: 0 }],
            }),
          ],
        },
      ],
    });
    expect(row!.clicked).toBe(0);
    expect(row!.clickedButtons).toBeNull();
  });

  it("converts Meta's UNIX SECONDS, not milliseconds", () => {
    // Passing/reading ms silently yields dates in the year 57000 — and Meta
    // returns an empty set for an out-of-range window rather than an error, so
    // the mistake reads as "no data" forever.
    const [row] = parseTemplateAnalytics({
      template_analytics: [{ data_points: [point({ start: 1_760_000_000 })] }],
    });
    expect(row!.date.getUTCFullYear()).toBe(2025);
  });

  it("skips malformed points instead of throwing the batch away", () => {
    const rows = parseTemplateAnalytics({
      template_analytics: [
        { data_points: [{ sent: 5 }, point(), { template_id: TPL }] },
      ],
    });
    // Only the well-formed one survives; one bad point must not lose the day.
    expect(rows).toHaveLength(1);
  });

  it("returns empty for an absent block rather than throwing", () => {
    expect(parseTemplateAnalytics({})).toEqual([]);
    expect(parseTemplateAnalytics({ template_analytics: null })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The rollup merge — the part that protects real history
// ---------------------------------------------------------------------------

describe("the daily rollup", () => {
  const DAY = new Date(Date.UTC(2026, 6, 1));

  async function seed(row: {
    read?: number | null;
    clicked?: number | null;
    cost?: number | null;
    sent?: number;
  }) {
    await prisma.templateAnalyticsDaily.upsert({
      where: {
        workspaceId_templateExternalId_date: {
          workspaceId,
          templateExternalId: TPL,
          date: DAY,
        },
      },
      create: {
        workspaceId,
        templateExternalId: TPL,
        date: DAY,
        sent: row.sent ?? 100,
        delivered: 95,
        read: row.read ?? null,
        clicked: row.clicked ?? null,
        costAmountSpent: row.cost ?? null,
        currency: row.cost != null ? "USD" : null,
      },
      update: {},
    });
  }

  /** The exact ON CONFLICT the service uses. Kept identical so this proves the
   *  shipped merge, not a paraphrase of it. */
  async function mergeIn(row: {
    read: number | null;
    clicked: number | null;
    cost: number | null;
    clickedButtons?: Array<{ type: string; buttonContent: string | null; count: number }> | null;
    sent?: number;
  }) {
    await prisma.$executeRaw`
      INSERT INTO "TemplateAnalyticsDaily" (
        "id", "workspaceId", "templateExternalId", "date",
        "sent", "delivered", "read", "clicked", "clickedButtons",
        "costAmountSpent", "currency", "fetchedAt"
      ) VALUES (
        ${`merge_${S}`}, ${workspaceId}, ${TPL}, ${DAY},
        ${row.sent ?? 100}, ${95}, ${row.read}, ${row.clicked},
        CAST(${row.clickedButtons == null ? null : JSON.stringify(row.clickedButtons)} AS jsonb),
        ${row.cost}, ${row.cost != null ? "USD" : null}, NOW()
      )
      ON CONFLICT ("workspaceId", "templateExternalId", "date") DO UPDATE SET
        "sent" = GREATEST(EXCLUDED."sent", "TemplateAnalyticsDaily"."sent"),
        "delivered" = GREATEST(EXCLUDED."delivered", "TemplateAnalyticsDaily"."delivered"),
        "read" = GREATEST(EXCLUDED."read", "TemplateAnalyticsDaily"."read"),
        "clicked" = GREATEST(EXCLUDED."clicked", "TemplateAnalyticsDaily"."clicked"),
        "clickedButtons" = COALESCE(EXCLUDED."clickedButtons", "TemplateAnalyticsDaily"."clickedButtons"),
        "costAmountSpent" = COALESCE(EXCLUDED."costAmountSpent", "TemplateAnalyticsDaily"."costAmountSpent"),
        "currency" = COALESCE(EXCLUDED."currency", "TemplateAnalyticsDaily"."currency"),
        "fetchedAt" = NOW()
    `;
  }

  it("NEVER lets a later null erase a captured read/click/cost", async () => {
    await prisma.templateAnalyticsDaily.deleteMany({ where: { workspaceId } });
    // Day 1: inside Meta's 7-day window — we get real numbers.
    await seed({ read: 80, clicked: 12, cost: 5.5 });

    // Three weeks later: Meta reports volume but no longer read/click/cost.
    await mergeIn({ read: null, clicked: null, cost: null });

    const row = await prisma.templateAnalyticsDaily.findFirstOrThrow({
      where: { workspaceId, templateExternalId: TPL },
    });
    // The whole reason this table is written with a raw merging upsert.
    expect(row.read).toBe(80);
    expect(row.clicked).toBe(12);
    expect(Number(row.costAmountSpent)).toBe(5.5);
    expect(row.currency).toBe("USD");
  });

  it("NEVER lets Meta's post-7-day ZERO reset erase a captured read/click", async () => {
    // The doc is explicit: after the 7-day window read/click "reset to zero" —
    // not absent, ZERO. A COALESCE-only merge survives the null case but lets
    // a refresh of an aged campaign overwrite captured history with 0s. This
    // is the GREATEST half of the merge.
    await prisma.templateAnalyticsDaily.deleteMany({ where: { workspaceId } });
    await seed({ read: 80, clicked: 12, cost: 5.5 });

    await mergeIn({ read: 0, clicked: 0, cost: null });

    const row = await prisma.templateAnalyticsDaily.findFirstOrThrow({
      where: { workspaceId, templateExternalId: TPL },
    });
    expect(row.read).toBe(80);
    expect(row.clicked).toBe(12);
  });

  it("keeps a captured button breakdown when a later fetch reports none", async () => {
    await prisma.templateAnalyticsDaily.deleteMany({ where: { workspaceId } });
    const captured = [{ type: "unique_url_button", buttonContent: "Tell me more", count: 16 }];
    await seed({ read: 80, clicked: 16 });
    await mergeIn({ read: 80, clicked: 16, cost: null, clickedButtons: captured });

    // Post-window refresh: the parser maps Meta's reset/empty breakdown to null.
    await mergeIn({ read: 0, clicked: 0, cost: null, clickedButtons: null });

    const row = await prisma.templateAnalyticsDaily.findFirstOrThrow({
      where: { workspaceId, templateExternalId: TPL },
    });
    expect(row.clickedButtons).toEqual(captured);
    expect(row.clicked).toBe(16);
  });

  it("DOES accept a newer, higher value", async () => {
    await prisma.templateAnalyticsDaily.deleteMany({ where: { workspaceId } });
    await seed({ read: 80, clicked: 12, cost: 5.5 });
    // Still inside the window — reads climbed. Preserving the old value here
    // would be just as wrong as erasing it in the previous test.
    await mergeIn({ read: 91, clicked: 15, cost: 6.25 });

    const row = await prisma.templateAnalyticsDaily.findFirstOrThrow({
      where: { workspaceId, templateExternalId: TPL },
    });
    expect(row.read).toBe(91);
    expect(row.clicked).toBe(15);
    expect(Number(row.costAmountSpent)).toBe(6.25);
  });
});

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

describe("readTemplateAnalytics", () => {
  beforeAll(async () => {
    await prisma.templateAnalyticsDaily.deleteMany({ where: { workspaceId } });
    await prisma.templateAnalyticsDaily.createMany({
      data: [
        {
          workspaceId,
          templateExternalId: TPL,
          date: new Date(Date.UTC(2026, 6, 1)),
          sent: 100,
          delivered: 90,
          read: 50,
          clicked: 5,
          clickedButtons: [
            { type: "unique_url_button", buttonContent: "Tell me more", count: 5 },
          ],
          costAmountSpent: "4.00",
          currency: "USD",
        },
        {
          workspaceId,
          templateExternalId: TPL,
          date: new Date(Date.UTC(2026, 6, 2)),
          sent: 200,
          delivered: 180,
          // Outside the window — genuinely unknown.
          read: null,
          clicked: null,
          costAmountSpent: "8.00",
          currency: "USD",
        },
      ],
    });
  });

  it("sums volume, and sums nullable metrics over the days that HAVE them", async () => {
    const { summary, days } = await readTemplateAnalytics(
      workspaceId,
      TPL,
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2026, 7, 1)),
    );
    expect(days).toHaveLength(2);
    expect(summary.sent).toBe(300);
    expect(summary.delivered).toBe(270);
    // One day knows, one doesn't. The known day still counts.
    expect(summary.read).toBe(50);
    expect(summary.costAmountSpent).toBe(12);
    // The breakdown aggregates over the days that carried one.
    expect(summary.clickedButtons).toEqual([
      { type: "unique_url_button", buttonContent: "Tell me more", count: 5 },
    ]);
    // Derived from TOTALS, not an average of per-day rates — otherwise a
    // 10-message day would weigh the same as a 10,000-message one.
    expect(summary.costPerDelivered).toBeCloseTo(12 / 270, 6);
  });

  it("keeps a total NULL when no day reported it, instead of collapsing to 0", async () => {
    await prisma.templateAnalyticsDaily.updateMany({
      where: { workspaceId, templateExternalId: TPL },
      data: { read: null, clicked: null },
    });
    const { summary } = await readTemplateAnalytics(
      workspaceId,
      TPL,
      new Date(Date.UTC(2026, 5, 1)),
      new Date(Date.UTC(2026, 7, 1)),
    );
    // "We don't know" must not render as "zero people read it".
    expect(summary.read).toBeNull();
    expect(summary.clicked).toBeNull();
    // Volume is still known.
    expect(summary.sent).toBe(300);
  });

  it("reports zero days for a window with no data, so callers can say so", async () => {
    const { summary } = await readTemplateAnalytics(
      workspaceId,
      TPL,
      new Date(Date.UTC(2020, 0, 1)),
      new Date(Date.UTC(2020, 0, 31)),
    );
    // `days === 0` is what lets the report distinguish "never fetched" from
    // "fetched, and it was a quiet week".
    expect(summary.days).toBe(0);
    expect(summary.sent).toBe(0);
  });
});
