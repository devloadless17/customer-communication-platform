import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { getProviderBinding } from "@/lib/providers";
import { invalidateProviderConfig } from "@/lib/providers/config";
import type { ProviderTemplateAnalyticsRow } from "@ccp/shared/providers/types";

/**
 * Meta's own template analytics — the aggregate half of campaign reporting.
 *
 * We already build a per-recipient delivery funnel from status webhooks. That
 * funnel is per-recipient TRUTH and the only source of `replied` and opt-outs.
 * It cannot, however, tell you two things Meta alone knows:
 *
 *   - what a campaign COST, in real currency;
 *   - how many people CLICKED a URL button (no webhook carries that).
 *
 * So the two are stored and rendered SIDE BY SIDE, never blended into one
 * number. Blending would produce a figure that matches neither source and
 * silently changes meaning as the 7-day read/click window expires.
 */

/** Meta's lookback ceiling. Asking for more returns nothing, not an error. */
export const ANALYTICS_MAX_LOOKBACK_DAYS = 90;
/** Meta's per-request template cap. */
export const ANALYTICS_TEMPLATE_BATCH = 10;

/**
 * Turn on template analytics for the workspace's WhatsApp account.
 *
 * IRREVERSIBLE at Meta. Guarded three ways: it is its own endpoint (never a
 * side effect of a read), it refuses when already enabled, and it stamps
 * `insightsEnabledAt` so the UI can offer it exactly once and every later
 * "why is there no data before March" has a dated answer.
 */
export async function enableTemplateInsights(workspaceId: string): Promise<{
  enabledAt: string;
  alreadyEnabled: boolean;
}> {
  const connection = await db.channelConnection.findFirst({
    where: { workspaceId, channel: "whatsapp", isDefault: true },
    select: { id: true, insightsEnabledAt: true },
  });
  if (!connection) {
    throw new BadRequestException({ error: "whatsapp_not_connected" });
  }
  if (connection.insightsEnabledAt) {
    // Not an error the caller must handle — idempotent success, because the
    // desired state is already reached and Meta offers no way to undo it.
    return { enabledAt: connection.insightsEnabledAt.toISOString(), alreadyEnabled: true };
  }

  const binding = getProviderBinding("whatsapp");
  const provider = binding.provider;
  if (!provider.enableTemplateInsights) {
    throw new BadRequestException({ error: "provider_lacks_template_insights" });
  }
  const config = await binding.getSendConfig(workspaceId);
  await provider.enableTemplateInsights(config);

  const enabledAt = new Date();
  // CAS on still-null so two admins pressing at once record one timestamp.
  const written = await db.channelConnection.updateMany({
    where: { id: connection.id, insightsEnabledAt: null },
    data: { insightsEnabledAt: enabledAt },
  });
  invalidateProviderConfig(workspaceId);
  if (written.count === 0) {
    const fresh = await db.channelConnection.findUnique({
      where: { id: connection.id },
      select: { insightsEnabledAt: true },
    });
    return {
      enabledAt: (fresh?.insightsEnabledAt ?? enabledAt).toISOString(),
      alreadyEnabled: true,
    };
  }
  return { enabledAt: enabledAt.toISOString(), alreadyEnabled: false };
}

export async function getInsightsStatus(workspaceId: string): Promise<{
  connected: boolean;
  enabled: boolean;
  enabledAt: string | null;
}> {
  const connection = await db.channelConnection.findFirst({
    where: { workspaceId, channel: "whatsapp", isDefault: true },
    select: { insightsEnabledAt: true },
  });
  return {
    connected: !!connection,
    enabled: !!connection?.insightsEnabledAt,
    enabledAt: connection?.insightsEnabledAt?.toISOString() ?? null,
  };
}

/**
 * Fetch a window of analytics from the provider and upsert the daily rollup.
 *
 * Returns how many template-days were written. Never called from a poll — see
 * the note on the refresh endpoints.
 */
export async function refreshTemplateAnalytics(
  workspaceId: string,
  opts: {
    templateExternalIds: string[];
    start: Date;
    end: Date;
    /**
     * The WABA whose catalog these templates belong to.
     *
     * Load-bearing on a multi-account workspace: `template_analytics` is a
     * field on the WABA node, so querying with the DEFAULT account's WABA
     * returns nothing for a template that lives under a second one — and an
     * empty result is indistinguishable from "this template sent nothing".
     * Resolved from the template rows by the callers below.
     */
    wabaId?: string | null;
  },
): Promise<{ rows: number; costWithheld: boolean }> {
  const ids = opts.templateExternalIds.filter(Boolean);
  if (ids.length === 0) return { rows: 0, costWithheld: false };

  const binding = getProviderBinding("whatsapp");
  const provider = binding.provider;
  if (!provider.fetchTemplateAnalytics) {
    throw new BadRequestException({ error: "provider_lacks_template_insights" });
  }
  // Select the ACCOUNT that owns this WABA, not just the workspace default.
  const accountId = opts.wabaId
    ? (
        await db.channelConnection.findFirst({
          where: { workspaceId, channel: "whatsapp", wabaId: opts.wabaId },
          select: { externalAccountId: true },
        })
      )?.externalAccountId ?? null
    : null;
  const config = await binding.getSendConfig(workspaceId, accountId);

  // Clamp to Meta's 90-day lookback rather than passing a wider window through:
  // an out-of-range start returns an EMPTY set, which is indistinguishable from
  // "this template sent nothing" and would be reported to the user as such.
  const floor = new Date(Date.now() - ANALYTICS_MAX_LOOKBACK_DAYS * 86_400_000);
  const start = opts.start < floor ? floor : opts.start;
  const end = opts.end;
  if (end < start) return { rows: 0, costWithheld: false };

  let written = 0;
  let sawCost = false;
  // Meta caps a request at 10 template ids.
  for (let i = 0; i < ids.length; i += ANALYTICS_TEMPLATE_BATCH) {
    const batch = ids.slice(i, i + ANALYTICS_TEMPLATE_BATCH);
    let rows: ProviderTemplateAnalyticsRow[];
    try {
      rows = await provider.fetchTemplateAnalytics(
        { templateExternalIds: batch, start, end },
        config,
      );
    } catch (err) {
      // Meta refuses the read until insights are enabled on the WABA. Translate
      // it into the one thing the admin can act on rather than a raw Graph
      // error, which reads like an outage.
      const msg = err instanceof Error ? err.message : String(err);
      if (/insight/i.test(msg)) {
        throw new ConflictException({ error: "template_insights_not_enabled" });
      }
      throw err;
    }
    for (const row of rows) {
      if (row.costAmountSpent !== null) sawCost = true;
      await upsertRollup(workspaceId, row);
      written++;
    }
  }
  return { rows: written, costWithheld: written > 0 && !sawCost };
}

/**
 * Upsert one template-day, MERGING rather than replacing the volatile fields.
 *
 * THE RULE: a captured non-null `read` / `clicked` / cost is never overwritten
 * with a later null. Meta reports read and click only for the last ~7 days, so
 * re-fetching a three-week-old campaign returns nulls for metrics we captured
 * correctly at the time. A naive upsert would zero out good history on every
 * refresh — and the damage is silent and permanent, because the source can no
 * longer produce those numbers.
 *
 * Written as raw SQL because this is exactly what `COALESCE(EXCLUDED.x, t.x)`
 * on an `ON CONFLICT` is for; expressing "keep the old value when the new one
 * is null" through Prisma's upsert would mean a read, a merge in JS and a
 * write — three statements and a race between them.
 */
async function upsertRollup(
  workspaceId: string,
  row: ProviderTemplateAnalyticsRow,
): Promise<void> {
  // Normalise to a UTC day so re-fetches land on the same row rather than
  // minting a second one an hour apart.
  const day = new Date(
    Date.UTC(row.date.getUTCFullYear(), row.date.getUTCMonth(), row.date.getUTCDate()),
  );
  await db.$executeRaw`
    INSERT INTO "TemplateAnalyticsDaily" (
      "id", "workspaceId", "templateExternalId", "date",
      "sent", "delivered", "read", "clicked",
      "costAmountSpent", "costPerDelivered", "costPerUrlClick", "currency", "fetchedAt"
    ) VALUES (
      ${`tad_${workspaceId.slice(-8)}_${row.templateExternalId}_${day.toISOString().slice(0, 10)}`},
      ${workspaceId}, ${row.templateExternalId}, ${day},
      ${row.sent}, ${row.delivered}, ${row.read}, ${row.clicked},
      ${row.costAmountSpent}, ${row.costPerDelivered}, ${row.costPerUrlClick},
      ${row.currency}, NOW()
    )
    ON CONFLICT ("workspaceId", "templateExternalId", "date") DO UPDATE SET
      -- Volume metrics are always reported, so the newest read wins.
      "sent" = EXCLUDED."sent",
      "delivered" = EXCLUDED."delivered",
      -- Volatile metrics: keep what we captured if Meta has stopped reporting.
      "read" = COALESCE(EXCLUDED."read", "TemplateAnalyticsDaily"."read"),
      "clicked" = COALESCE(EXCLUDED."clicked", "TemplateAnalyticsDaily"."clicked"),
      "costAmountSpent" = COALESCE(EXCLUDED."costAmountSpent", "TemplateAnalyticsDaily"."costAmountSpent"),
      "costPerDelivered" = COALESCE(EXCLUDED."costPerDelivered", "TemplateAnalyticsDaily"."costPerDelivered"),
      "costPerUrlClick" = COALESCE(EXCLUDED."costPerUrlClick", "TemplateAnalyticsDaily"."costPerUrlClick"),
      "currency" = COALESCE(EXCLUDED."currency", "TemplateAnalyticsDaily"."currency"),
      "fetchedAt" = NOW()
  `;
}

/** One day of a template's stored analytics, as the API returns it. */
export interface TemplateAnalyticsDay {
  date: string;
  sent: number;
  delivered: number;
  read: number | null;
  clicked: number | null;
  costAmountSpent: number | null;
  currency: string | null;
}

/** Totals over a window, plus the honest reason any field is null. */
export interface TemplateAnalyticsSummary {
  sent: number;
  delivered: number;
  read: number | null;
  clicked: number | null;
  costAmountSpent: number | null;
  costPerDelivered: number | null;
  currency: string | null;
  /** Days actually covered by stored data — so "0 sent" and "never fetched"
   *  can be told apart in the UI. */
  days: number;
}

/**
 * Read the stored rollup for one template over a date range. A plain indexed
 * range read — no Graph call, so the broadcast report can include it without
 * making a network hop on every poll.
 */
export async function readTemplateAnalytics(
  workspaceId: string,
  templateExternalId: string,
  start: Date,
  end: Date,
): Promise<{ days: TemplateAnalyticsDay[]; summary: TemplateAnalyticsSummary }> {
  const rows = await db.templateAnalyticsDaily.findMany({
    where: { workspaceId, templateExternalId, date: { gte: dayOf(start), lte: dayOf(end) } },
    orderBy: { date: "asc" },
    select: {
      date: true,
      sent: true,
      delivered: true,
      read: true,
      clicked: true,
      costAmountSpent: true,
      costPerDelivered: true,
      currency: true,
    },
  });

  const days: TemplateAnalyticsDay[] = rows.map((r) => ({
    date: r.date.toISOString().slice(0, 10),
    sent: r.sent,
    delivered: r.delivered,
    read: r.read,
    clicked: r.clicked,
    costAmountSpent: decimalToNumber(r.costAmountSpent),
    currency: r.currency,
  }));

  // Summing NULLABLE metrics: a null contributes nothing, but if EVERY day is
  // null the total stays null rather than collapsing to 0. "We don't know" and
  // "zero" must not render identically — one is a gap, the other is a result.
  const sumNullable = (pick: (r: (typeof rows)[number]) => number | null): number | null => {
    let total = 0;
    let any = false;
    for (const r of rows) {
      const v = pick(r);
      if (v !== null) {
        total += v;
        any = true;
      }
    }
    return any ? total : null;
  };

  const sent = rows.reduce((a, r) => a + r.sent, 0);
  const delivered = rows.reduce((a, r) => a + r.delivered, 0);
  const cost = sumNullable((r) => decimalToNumber(r.costAmountSpent));

  return {
    days,
    summary: {
      sent,
      delivered,
      read: sumNullable((r) => r.read),
      clicked: sumNullable((r) => r.clicked),
      costAmountSpent: cost,
      // Derived from the totals rather than averaging per-day rates, which
      // would weight a 10-message day the same as a 10,000-message one.
      costPerDelivered: cost !== null && delivered > 0 ? cost / delivered : null,
      currency: rows.find((r) => r.currency)?.currency ?? null,
      days: rows.length,
    },
  };
}

function dayOf(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function decimalToNumber(v: Prisma.Decimal | null): number | null {
  return v === null ? null : Number(v);
}
