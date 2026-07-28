import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { getCountryFromPhone } from "@ccp/shared/utils";

import { db } from "@/lib/db";
import { getProviderBinding } from "@/lib/providers";
import { invalidateProviderConfig } from "@/lib/providers/config";
import type {
  ProviderTemplateAnalyticsRow,
  TemplateButtonClicks,
} from "@ccp/shared/providers/types";

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
  // Resolve credentials for the connection we just read, not "whatever the
  // workspace defaults to". Passing nothing used to mean the same thing, but
  // since the account-unresolved guard it means an outright throw the moment a
  // workspace has two active numbers — so this route 500'd for exactly the
  // customers most likely to want analytics. Naming the row also keeps the
  // Graph call and the `insightsEnabledAt` stamp below on the SAME account.
  //
  // Still default-account-only by design: insights are a per-WABA switch and
  // this route takes no `?accountId=` (unlike its siblings on this controller),
  // so a second WABA cannot be enabled yet. Tracked as an open gap.
  const config = await binding.getSendConfig(workspaceId, connection.id);
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
  // `getSendConfig` resolves its accountId against the connection ROW id —
  // this used to pass `externalAccountId` (Meta's id), which matches no row,
  // loads as "not-connected" and failed EVERY refresh for a synced template.
  // That was the real bug behind the report's unexplained "Couldn't fetch
  // from Meta".
  const accountId = opts.wabaId
    ? (
        await db.channelConnection.findFirst({
          where: { workspaceId, channel: "whatsapp", wabaId: opts.wabaId },
          select: { id: true },
        })
      )?.id ?? null
    : null;
  // Config resolution fails for reasons the operator can fix (missing WABA id
  // on the connection, undecryptable token) — but ProviderNotConfiguredError is
  // a plain Error, and unwrapped it surfaced as a bare 500 whose toast could
  // only say "Couldn't fetch from Meta". Wrap it HERE so the reason travels.
  let config: Awaited<ReturnType<typeof binding.getSendConfig>>;
  try {
    config = await binding.getSendConfig(workspaceId, accountId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[template-analytics] send-config unavailable for workspace=${workspaceId}:`,
      msg,
    );
    throw new BadRequestException({
      error: "whatsapp_not_configured",
      detail: msg.slice(0, 300),
    });
  }

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
      // Server-side trail regardless of what the client shows — "the toast
      // said X" must always be reconstructible from the logs.
      console.warn(
        `[template-analytics] fetch failed for workspace=${workspaceId}:`,
        msg,
      );
      if (/insight/i.test(msg)) {
        throw new ConflictException({ error: "template_insights_not_enabled" });
      }
      // Any other Graph refusal: keep it structured and carry Meta's OWN
      // sentence as `detail`. Left raw this surfaced as a bare 500 and the UI
      // could only say "Couldn't fetch from Meta" — an operator staring at
      // that toast has nothing to act on, and neither did we when they
      // reported it. (Unsupported-region WABAs, expired tokens and permission
      // gaps all land here with distinct, actionable messages.)
      throw new BadGatewayException({
        error: "meta_analytics_fetch_failed",
        detail: metaErrorSentence(msg),
      });
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
 * THE RULE: a captured `read` / `clicked` / cost is never overwritten with a
 * later null OR ZERO. Meta reports read and click only for the last ~7 days —
 * and its analytics doc is explicit that after that window the counts "reset
 * to zero", not merely go absent. So a refresh of a three-week-old campaign
 * (the report's Fetch button reaches back up to 90 days) legitimately returns
 * 0s for metrics we captured correctly at the time. COALESCE alone survives
 * the null case but not the zero case, which is why read/clicked merge with
 * GREATEST: within the live window a fixed day's count only grows, and after
 * the reset the stored high-water mark wins. The damage a plain overwrite does
 * is silent and permanent, because the source can no longer produce those
 * numbers.
 *
 * Written as raw SQL because this is exactly what `ON CONFLICT ... DO UPDATE`
 * merge expressions are for; expressing it through Prisma's upsert would mean
 * a read, a merge in JS and a write — three statements and a race between
 * them. (Postgres GREATEST ignores nulls, so it doubles as the null guard.)
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
      "sent", "delivered", "read", "clicked", "clickedButtons",
      "costAmountSpent", "costPerDelivered", "costPerUrlClick", "currency", "fetchedAt"
    ) VALUES (
      ${`tad_${workspaceId.slice(-8)}_${row.templateExternalId}_${day.toISOString().slice(0, 10)}`},
      ${workspaceId}, ${row.templateExternalId}, ${day},
      ${row.sent}, ${row.delivered}, ${row.read}, ${row.clicked},
      CAST(${row.clickedButtons === null ? null : JSON.stringify(row.clickedButtons)} AS jsonb),
      ${row.costAmountSpent}, ${row.costPerDelivered}, ${row.costPerUrlClick},
      ${row.currency}, NOW()
    )
    ON CONFLICT ("workspaceId", "templateExternalId", "date") DO UPDATE SET
      -- Volume metrics: monotone, never newest-wins. A day's sent/delivered
      -- count for a FIXED event day only ever grows, but two fetchers hit this
      -- row with different windows (the sweeper's full-range vs a report
      -- refresh narrowed to one campaign's send window) and an absent field
      -- parses to 0 — plain overwrite let a later, narrower or emptier read
      -- shrink a captured figure nondeterministically. GREATEST keeps the high
      -- water mark and still tracks growth.
      "sent" = GREATEST(EXCLUDED."sent", "TemplateAnalyticsDaily"."sent"),
      "delivered" = GREATEST(EXCLUDED."delivered", "TemplateAnalyticsDaily"."delivered"),
      -- Read/click: same monotone rule, for a harsher reason — after the 7-day
      -- window Meta RESETS these to zero, so a plain COALESCE would let a late
      -- refresh erase captured history with 0s. GREATEST ignores nulls, so it
      -- covers both the null case and the reset case.
      "read" = GREATEST(EXCLUDED."read", "TemplateAnalyticsDaily"."read"),
      "clicked" = GREATEST(EXCLUDED."clicked", "TemplateAnalyticsDaily"."clicked"),
      -- The breakdown can't GREATEST; the parser maps a post-reset (all-zero)
      -- breakdown to null instead, so COALESCE keeps the captured one.
      "clickedButtons" = COALESCE(EXCLUDED."clickedButtons", "TemplateAnalyticsDaily"."clickedButtons"),
      -- Cost is monotone for the same reason the volume metrics are, and Meta's
      -- doc says why outright: amount_spent is "total amount spent on
      -- conversations opened WITHIN THE START AND END TIMEFRAME". It is scoped
      -- to the REQUESTED WINDOW, not just the day bucket — so the campaign
      -- report's narrow refresh legitimately returns a smaller figure for a day
      -- than the sweeper's wide one, and COALESCE (newest non-null wins) let the
      -- narrower read shrink a captured cost. Widening the window can only add
      -- conversations to a fixed day, so the high-water mark is the complete
      -- figure. The RATIOS below stay on COALESCE — GREATEST on a rate would
      -- keep whichever window happened to divide most favourably, and the
      -- summary derives its own cost-per-delivered from the totals anyway.
      "costAmountSpent" = GREATEST(EXCLUDED."costAmountSpent", "TemplateAnalyticsDaily"."costAmountSpent"),
      "costPerDelivered" = COALESCE(EXCLUDED."costPerDelivered", "TemplateAnalyticsDaily"."costPerDelivered"),
      "costPerUrlClick" = COALESCE(EXCLUDED."costPerUrlClick", "TemplateAnalyticsDaily"."costPerUrlClick"),
      "currency" = COALESCE(EXCLUDED."currency", "TemplateAnalyticsDaily"."currency"),
      "fetchedAt" = NOW()
  `;
}

/**
 * Resolve a campaign's template to Meta's id + the WABA its analytics live under.
 *
 * A campaign records the template NAME and LANGUAGE it sent, never a foreign key,
 * and `@@unique([workspaceId, wabaId, name, language])` lets two WABAs in one
 * workspace each hold a row with that pair. The name is therefore ambiguous — and
 * the two callers broke the tie DIFFERENTLY: the report took `syncedAt desc`, the
 * campaign refresh took whatever Postgres happened to return first. When they
 * disagreed, Fetch wrote the rollup under one externalId while the report read the
 * other, so a successful "Updated N days from Meta" toast sat above a panel that
 * never changed — and no error was raised anywhere, because both halves worked.
 *
 * The tie is broken by the account the campaign actually SENT from
 * (`Broadcast.channelConnectionId` → `ChannelConnection.wabaId`). That is not a
 * heuristic: templates live on a WABA's catalog, `template_analytics` is scoped to
 * the WABA node, so the sending account's WABA is the only one whose figures can
 * hold this campaign at all. `syncedAt desc` survives only as the fallback for
 * pre-multi-account rows that carry no connection.
 */
export async function resolveCampaignTemplate(
  workspaceId: string,
  campaign: {
    templateName: string | null;
    templateLanguage: string | null;
    channelConnectionId: string | null;
  },
): Promise<{ externalId: string; wabaId: string | null } | null> {
  if (!campaign.templateName) return null;

  const sendingWabaId = campaign.channelConnectionId
    ? (
        await db.channelConnection.findFirst({
          // workspaceId even though the id is unique — the row is reached from
          // request-derived state and tenancy is manual everywhere in this app.
          where: { id: campaign.channelConnectionId, workspaceId },
          select: { wabaId: true },
        })
      )?.wabaId || null
    : null;

  const where = {
    workspaceId,
    name: campaign.templateName,
    ...(campaign.templateLanguage ? { language: campaign.templateLanguage } : {}),
    externalId: { not: null },
  };
  const select = { externalId: true, wabaId: true };

  const row =
    (sendingWabaId
      ? await db.messageTemplate.findFirst({ where: { ...where, wabaId: sendingWabaId }, select })
      : null) ??
    // Fallback only: no sending account recorded, or its catalog no longer holds
    // the template. Most-recently-synced beats an arbitrary pick, and every
    // caller now lands on the SAME arbitrary pick, which is the property that
    // was actually missing.
    (await db.messageTemplate.findFirst({ where, orderBy: { syncedAt: "desc" }, select }));

  if (!row?.externalId) return null;
  // `""` is the legacy/unknown-WABA sentinel — normalise it to "no opinion" so
  // callers pass null and get the workspace's default account.
  return { externalId: row.externalId, wabaId: row.wabaId || null };
}

/**
 * Countries where Meta does not serve template analytics AT ALL.
 *
 * Its Analytics doc: "WABAs owned by or shared with Meta Business Accounts in
 * the European Union or Japan, or that have a business phone number with a
 * country calling code from any of those countries or regions, are not
 * supported." Meta does not error on those accounts — the fetch succeeds and
 * every figure comes back zero, which is indistinguishable from a campaign
 * nobody read, forever. It is also indistinguishable from OUR bugs, which is
 * why it has to be named on screen rather than left to look like one.
 *
 * ISO-3166 alpha-2, matched against the connected number's own country (Meta's
 * "business phone number with a country calling code" half of the rule). The
 * ownership half — an EU/JP Meta Business Account behind a non-EU number — is
 * not knowable from any field we hold, so this detects most of the rule and
 * never claims to detect all of it.
 */
const TEMPLATE_ANALYTICS_BLOCKED_COUNTRIES = new Set([
  // EU 27
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
  "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK",
  "SI", "ES", "SE",
  // Japan
  "JP",
]);

/** What the account behind a template says about its analytics. */
export interface TemplateAnalyticsAccountContext {
  /** When Meta STARTED recording for this WABA. Nothing before it is ever
   *  backfilled, so days earlier than this read zero by design. */
  analyticsSince: string | null;
  /** The connected number sits in a region Meta excludes from template
   *  analytics — every figure will be zero no matter what we do. */
  regionUnsupported: boolean;
}

/**
 * Why this WABA's numbers might be zero — resolved once, for every surface.
 *
 * Both analytics readers (the campaign report and the template drawer) need the
 * same two facts about the same connection, and both had grown their own copy
 * of the lookup. One definition keeps them from drifting into telling an
 * operator two different stories about one account.
 */
export async function templateAnalyticsAccountContext(
  workspaceId: string,
  wabaId: string | null,
): Promise<TemplateAnalyticsAccountContext> {
  const connection = await db.channelConnection.findFirst({
    where: {
      workspaceId,
      channel: "whatsapp",
      // `""`/null WABA = a pre-multi-account row; fall back to the default
      // account, which is the only one it could have meant.
      ...(wabaId ? { wabaId } : { isDefault: true }),
    },
    select: { insightsEnabledAt: true, config: true },
  });
  const config = (connection?.config ?? {}) as { displayPhoneNumber?: string };
  const country = getCountryFromPhone(config.displayPhoneNumber ?? null);
  return {
    analyticsSince: connection?.insightsEnabledAt?.toISOString() ?? null,
    // An unparseable or absent number leaves `country` null — treat that as
    // supported. Claiming "Meta doesn't cover your region" on a guess is worse
    // than the unexplained zero it was meant to explain.
    regionUnsupported: country !== null && TEMPLATE_ANALYTICS_BLOCKED_COUNTRIES.has(country),
  };
}

/** One day of a template's stored analytics, as the API returns it. */
export interface TemplateAnalyticsDay {
  date: string;
  sent: number;
  delivered: number;
  read: number | null;
  clicked: number | null;
  clickedButtons: TemplateButtonClicks[] | null;
  costAmountSpent: number | null;
  currency: string | null;
}

/** Totals over a window, plus the honest reason any field is null. */
export interface TemplateAnalyticsSummary {
  sent: number;
  delivered: number;
  read: number | null;
  clicked: number | null;
  /** Per-button click totals over the window, summed by (type, label). Null
   *  when no day carried a breakdown. Note `unique_url_button` counts are
   *  unique PER DAY at Meta, so a multi-day sum can count one person twice. */
  clickedButtons: TemplateButtonClicks[] | null;
  costAmountSpent: number | null;
  costPerDelivered: number | null;
  currency: string | null;
  /** Days actually covered by stored data — so "0 sent" and "never fetched"
   *  can be told apart in the UI. */
  days: number;
  /** When any of this window's rows was last captured from Meta — the
   *  freshness stamp the UI shows so "live-ish aggregate" is never mistaken
   *  for a realtime feed. Null when nothing is stored. */
  fetchedAt: string | null;
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
      clickedButtons: true,
      costAmountSpent: true,
      costPerDelivered: true,
      currency: true,
      fetchedAt: true,
    },
  });

  const days: TemplateAnalyticsDay[] = rows.map((r) => ({
    date: r.date.toISOString().slice(0, 10),
    sent: r.sent,
    delivered: r.delivered,
    read: r.read,
    clicked: r.clicked,
    clickedButtons: buttonClicksOf(r.clickedButtons),
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

  // Aggregate the per-button breakdown by (type, label) over the days that
  // carried one. Same null discipline as the scalars: no day reported → null.
  const byButton = new Map<string, TemplateButtonClicks>();
  for (const day of days) {
    for (const b of day.clickedButtons ?? []) {
      // NUL as the composite-key separator (it can't occur in either part).
      // Written as the ESCAPE, never as a literal byte: a raw NUL in a source
      // file makes grep, git grep and code search classify the whole file as
      // binary and skip it, so it vanishes from every repo-wide sweep — which
      // is how the account-resolution bug fixed above survived an audit that
      // grepped for exactly its call site.
      const key = `${b.type}\u0000${b.buttonContent ?? ""}`;
      const prev = byButton.get(key);
      if (prev) prev.count += b.count;
      else byButton.set(key, { ...b });
    }
  }

  return {
    days,
    summary: {
      sent,
      delivered,
      read: sumNullable((r) => r.read),
      clicked: sumNullable((r) => r.clicked),
      clickedButtons: byButton.size ? [...byButton.values()] : null,
      costAmountSpent: cost,
      // Derived from the totals rather than averaging per-day rates, which
      // would weight a 10-message day the same as a 10,000-message one.
      costPerDelivered: cost !== null && delivered > 0 ? cost / delivered : null,
      currency: rows.find((r) => r.currency)?.currency ?? null,
      days: rows.length,
      fetchedAt:
        rows.length > 0
          ? new Date(Math.max(...rows.map((r) => r.fetchedAt.getTime()))).toISOString()
          : null,
    },
  };
}

function dayOf(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Pull the human sentence out of a Graph error. Provider errors read
 * `meta fetchTemplateAnalytics failed: 400 {"error":{"message":"...",...}}` —
 * the embedded message is the part an operator can act on; the wrapper is
 * noise. Falls back to the raw text (bounded) when the body isn't Graph JSON.
 */
function metaErrorSentence(raw: string): string {
  const jsonStart = raw.indexOf("{");
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart)) as {
        error?: { message?: unknown; error_user_msg?: unknown };
      };
      const msg = parsed.error?.error_user_msg ?? parsed.error?.message;
      if (typeof msg === "string" && msg.length > 0) return msg.slice(0, 300);
    } catch {
      // fall through to the raw text
    }
  }
  return raw.slice(0, 300);
}

/** Narrow the stored JSON back to the typed breakdown; malformed → null,
 *  never a throw — one bad row must not take the whole report down. */
function buttonClicksOf(v: Prisma.JsonValue | null): TemplateButtonClicks[] | null {
  if (!Array.isArray(v)) return null;
  const out: TemplateButtonClicks[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.type !== "string" || typeof e.count !== "number") continue;
    out.push({
      type: e.type,
      buttonContent: typeof e.buttonContent === "string" ? e.buttonContent : null,
      count: e.count,
    });
  }
  return out.length ? out : null;
}

function decimalToNumber(v: Prisma.Decimal | null): number | null {
  return v === null ? null : Number(v);
}
