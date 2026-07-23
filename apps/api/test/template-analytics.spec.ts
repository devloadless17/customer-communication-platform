/**
 * Meta template analytics — the parser and the daily rollup.
 *
 * One property carries almost all the risk here: **a captured metric must never
 * be overwritten by a later null.**
 *
 * Meta reports READ and CLICKED only for the last ~7 days, and withholds COST
 * entirely for Solution-Partner-billed WABAs. So re-fetching a three-week-old
 * campaign legitimately returns nulls for numbers we captured correctly at the
 * time. A naive upsert would zero out good history on every refresh — and the
 * damage is permanent and silent, because the source can no longer produce
 * those numbers. That is what the COALESCE merge exists for, and what most of
 * this file tests.
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

  it("pulls the three cost types out of Meta's typed array", () => {
    const [row] = parseTemplateAnalytics({
      template_analytics: [
        {
          data_points: [
            point({
              cost: [
                { type: "AMOUNT_SPENT", value: 12.5, currency: "USD" },
                { type: "COST_PER_DELIVERED", value: 0.13, currency: "USD" },
                { type: "COST_PER_URL_BUTTON_CLICK", value: 0.9, currency: "USD" },
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
  }) {
    await prisma.$executeRaw`
      INSERT INTO "TemplateAnalyticsDaily" (
        "id", "workspaceId", "templateExternalId", "date",
        "sent", "delivered", "read", "clicked", "costAmountSpent", "currency", "fetchedAt"
      ) VALUES (
        ${`merge_${S}`}, ${workspaceId}, ${TPL}, ${DAY},
        ${100}, ${95}, ${row.read}, ${row.clicked}, ${row.cost}, ${row.cost != null ? "USD" : null}, NOW()
      )
      ON CONFLICT ("workspaceId", "templateExternalId", "date") DO UPDATE SET
        "sent" = EXCLUDED."sent",
        "delivered" = EXCLUDED."delivered",
        "read" = COALESCE(EXCLUDED."read", "TemplateAnalyticsDaily"."read"),
        "clicked" = COALESCE(EXCLUDED."clicked", "TemplateAnalyticsDaily"."clicked"),
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
    // The whole reason this table is written with a raw COALESCE upsert.
    expect(row.read).toBe(80);
    expect(row.clicked).toBe(12);
    expect(Number(row.costAmountSpent)).toBe(5.5);
    expect(row.currency).toBe("USD");
  });

  it("DOES accept a newer non-null value", async () => {
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
