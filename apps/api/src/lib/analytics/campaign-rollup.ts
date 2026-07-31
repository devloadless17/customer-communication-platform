/**
 * CAMPAIGN ROLLUP — several broadcasts, one set of numbers.
 *
 * A campaign is rarely one send. It is one per channel, one per account, a
 * re-send to the people who didn't open the first, and a follow-up next week.
 * Read individually those are four unremarkable reports; read together they are
 * the only view that answers "did the spring sale work".
 *
 * ## Summed from recipients, never from other reports
 *
 * Every figure here is a fresh aggregate over `BroadcastRecipient`, the same rows
 * the single-campaign report reads. It deliberately does NOT add up per-broadcast
 * report objects: those carry derived RATES, and averaging rates across sends of
 * different sizes produces a number that is wrong in a way nobody can see — a
 * 100%-delivered send of 3 and a 50%-delivered send of 10,000 do not average to
 * 75%. Rates are computed once, at the end, from summed counts.
 *
 * ## Every breakdown answers a question the totals raise
 *
 * A campaign total is where the reading STARTS. "62% delivered" is only useful
 * next to which send, which Page, and which failure dragged it down — so the
 * rollup carries four cuts of the same recipient rows, each one the answer to
 * the obvious next question:
 *
 *   - **per broadcast** — which send in the campaign worked
 *   - **per account** — which Page / number / WABA it went out from, the cut that
 *     only exists because the runner stamps `channelConnectionId` per recipient
 *   - **per failure code** — WHY the failures failed, in the same vocabulary the
 *     send path uses (`MetaErrorCode`), so an operator reads one taxonomy
 *   - **per cost line** — Meta's `pricing` category/type, which is what makes a
 *     mixed billable column explicable rather than looking like our bug
 *
 * Plus the reverse lookup the totals cannot give: **where the people this
 * campaign reached originally came from** — the ad, post or link that acquired
 * them, joined from their first attributed inbound. That is the only figure here
 * that closes the loop between spend and outcome.
 *
 * ## Cost
 *
 * One indexed lookup of the campaign's broadcast ids (the partial
 * `Broadcast_campaign_rollup_idx`), then a small fixed number of aggregates over
 * their recipients, every one riding `@@index([broadcastId, deliveryState, id])`
 * — the same index the per-campaign funnel already uses. Fixed, not
 * per-broadcast: each cut is ONE `= ANY(ids)` aggregate, so a campaign of forty
 * sends costs the same number of round trips as a campaign of one.
 */

import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { ERROR_LABELS } from "@/lib/broadcast-report";
import { failureBucket, type FailureBucket } from "@/lib/providers/meta-send-error";

/**
 * The funnel, as counted from recipient rows. Shared by the campaign total and
 * by every breakdown, so a per-Page row and the headline are read the same way
 * and can never drift into two definitions of "reached".
 */
export interface CampaignFunnel {
  targeted: number;
  /** Reached a handset (delivered or read). */
  reached: number;
  read: number;
  /** Never reached one, whatever the cause. */
  failed: number;
  replied: number;
  clicked: number;
  /** Opted out inside the campaign's attribution window. */
  optedOut: number;
}

export interface CampaignRollup extends CampaignFunnel {
  campaignName: string;
  /** Every send in the campaign with its OWN funnel, newest first. */
  broadcasts: Array<{
    id: string;
    name: string | null;
    channel: string;
    status: string;
    createdAt: string;
    funnel: CampaignFunnel;
  }>;
  /**
   * Per SENDING ACCOUNT — which Page, IG account or number this went out from.
   *
   * Exists because a social campaign fans out across every account that ever
   * talked to the audience (a PSID is issued by one Page and is meaningless to
   * another), so "the campaign underperformed" is very often "one Page is
   * restricted". `accountId` is null for the rows the runner sent from the
   * campaign's own account — every WhatsApp send and every single-account run.
   */
  accounts: Array<{
    accountId: string | null;
    label: string;
    channel: string | null;
    /** The account row is gone but its historical stamp remains. */
    deleted: boolean;
    funnel: CampaignFunnel;
  }>;
  /**
   * WHY the failures failed, in the same vocabulary the send path uses.
   *
   * `label` and `bucket` are resolved HERE, from the single-broadcast report's
   * own maps, rather than re-spelled in the web app — a second copy of this
   * vocabulary is how the campaign page and the broadcast page end up calling
   * one Meta error two different things. `metaCode` is Meta's raw numeric code,
   * kept for codes we have not mapped yet: it is what you quote in a support
   * thread.
   */
  failures: Array<{
    code: string;
    label: string;
    /**
     * `retryable` · `permanent` · `suppress` · `content` — what an operator can
     * DO about it, which is the only reason a failure list is worth reading.
     */
    bucket: FailureBucket;
    metaCode: number | null;
    count: number;
  }>;
  /**
   * Meta's own pricing lines. No currency amount anywhere — Meta sends a
   * category and a billable flag, never a price, and a computed amount would
   * freeze a stale rate card into the audit trail. Counts, so the operator
   * applies their own rates.
   */
  cost: Array<{
    category: string | null;
    /** `regular` · `free_customer_service` · `free_entry_point` · … */
    type: string | null;
    billable: boolean | null;
    count: number;
  }>;
  /**
   * WHERE the people this campaign reached originally came from — the ad, post
   * or link that acquired them. Joined from each contact's first attributed
   * inbound, the same rule the acquisition report uses, so the two agree.
   */
  sources: Array<{
    source: string;
    sourceId: string | null;
    headline: string | null;
    contacts: number;
  }>;
  /** Distinct PEOPLE reached across the campaign — not message count. */
  contactsReached: number;
  /** reached / targeted, computed once from summed counts. See the header. */
  deliveryRate: number | null;
  /** read / reached. */
  readRate: number | null;
}

/** Raw counts as Postgres returns them, before Number() narrowing. */
interface FunnelRow {
  targeted: bigint;
  reached: bigint;
  read: bigint;
  failed: bigint;
  replied: bigint;
  clicked: bigint;
  optedOut: bigint;
}

/** First candidate that is actually a label — blank and whitespace don't count. */
function firstLabel(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) if (c && c.trim() !== "") return c;
  return null;
}

function toFunnel(r: FunnelRow | undefined): CampaignFunnel {
  return {
    targeted: Number(r?.targeted ?? 0),
    reached: Number(r?.reached ?? 0),
    read: Number(r?.read ?? 0),
    failed: Number(r?.failed ?? 0),
    replied: Number(r?.replied ?? 0),
    clicked: Number(r?.clicked ?? 0),
    optedOut: Number(r?.optedOut ?? 0),
  };
}

/**
 * The funnel's SELECT list, written once.
 *
 * Every cut below counts the same seven things, and the one time these were
 * spelled out per query the per-account cut quietly used a different definition
 * of `failed` than the headline did — two numbers for one fact, with nothing on
 * screen to say they were measured differently.
 */
const FUNNEL_SELECT = Prisma.sql`
  count(*)                                                        AS targeted,
  count(*) FILTER (WHERE "deliveryState" IN ('delivered','read'))  AS reached,
  count(*) FILTER (WHERE "deliveryState" = 'read')                 AS read,
  count(*) FILTER (WHERE "deliveryState" IN ('failed_at_send','undelivered')) AS failed,
  count(*) FILTER (WHERE "repliedAt"  IS NOT NULL)                 AS replied,
  count(*) FILTER (WHERE "clickedAt"  IS NOT NULL)                 AS clicked,
  count(*) FILTER (WHERE "optedOutAt" IS NOT NULL)                 AS "optedOut"
`;

export async function campaignRollup(
  workspaceId: string,
  campaignName: string,
): Promise<CampaignRollup | null> {
  const broadcasts = await db.broadcast.findMany({
    where: { workspaceId, campaignName },
    select: { id: true, name: true, channel: true, status: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  if (broadcasts.length === 0) return null;

  const ids = broadcasts.map((b) => b.id);

  // Every cut is one aggregate over the same row set. Run together: they share
  // no state, and serialising them would make the page wait for the sum of five
  // scans instead of the slowest one.
  const [totalRows, perBroadcast, perAccount, failures, cost, sources] = await Promise.all([
    db.$queryRaw<(FunnelRow & { contactsReached: bigint })[]>`
      SELECT ${FUNNEL_SELECT},
             -- DISTINCT contacts, because the same person is legitimately
             -- targeted by several sends in one campaign (the re-send to
             -- non-openers is exactly that). Summing per-broadcast reach would
             -- count them twice and report a campaign as having reached more
             -- people than exist.
             count(DISTINCT "contactId") FILTER (
               WHERE "deliveryState" IN ('delivered','read')
             ) AS "contactsReached"
      FROM "BroadcastRecipient"
      WHERE "broadcastId" = ANY(${ids})
    `,
    db.$queryRaw<(FunnelRow & { broadcastId: string })[]>`
      SELECT "broadcastId", ${FUNNEL_SELECT}
      FROM "BroadcastRecipient"
      WHERE "broadcastId" = ANY(${ids})
      GROUP BY "broadcastId"
    `,
    db.$queryRaw<(FunnelRow & { accountId: string | null })[]>`
      SELECT "channelConnectionId" AS "accountId", ${FUNNEL_SELECT}
      FROM "BroadcastRecipient"
      WHERE "broadcastId" = ANY(${ids})
      GROUP BY "channelConnectionId"
    `,
    db.$queryRaw<{ code: string; metaCode: number | null; count: bigint }[]>`
      SELECT "errorCode" AS code,
             -- One representative raw code per normalized bucket. MIN keeps it
             -- deterministic rather than whichever row Postgres reached first;
             -- it is a forensic hint for a support thread, not a statistic.
             MIN("metaErrorCode") AS "metaCode",
             count(*) AS count
      FROM "BroadcastRecipient"
      WHERE "broadcastId" = ANY(${ids})
        AND "errorCode" IS NOT NULL
      GROUP BY "errorCode"
      ORDER BY count(*) DESC
    `,
    db.$queryRaw<
      { category: string | null; type: string | null; billable: boolean | null; count: bigint }[]
    >`
      SELECT "pricingCategory" AS category,
             "pricingType"     AS type,
             "pricingBillable" AS billable,
             count(*)          AS count
      FROM "BroadcastRecipient"
      WHERE "broadcastId" = ANY(${ids})
        -- Only recipients Meta actually priced. A queued or failed row has no
        -- pricing block at all, and a (null, null, null) line at the top of the
        -- cost table reads as "we could not price most of this campaign".
        AND ("pricingCategory" IS NOT NULL OR "pricingType" IS NOT NULL)
      GROUP BY "pricingCategory", "pricingType", "pricingBillable"
      ORDER BY count(*) DESC
    `,
    // WHERE the reached people originally came from. Same rule as the
    // acquisition report — FIRST attributed inbound per contact — so a campaign
    // page and the acquisition panel never disagree about which ad won someone.
    db.$queryRaw<
      { source: string | null; sourceId: string | null; headline: string | null; contacts: bigint }[]
    >`
      WITH reached AS (
        SELECT DISTINCT "contactId"
        FROM "BroadcastRecipient"
        WHERE "broadcastId" = ANY(${ids})
          AND "deliveryState" IN ('delivered','read')
      ), first_attributed AS (
        SELECT DISTINCT ON (conv."contactId")
               conv."contactId"                       AS "contactId",
               m."attribution"->>'source'             AS "source",
               COALESCE(
                 m."attribution"->>'adId',
                 m."attribution"->>'postId',
                 m."attribution"->>'ref'
               )                                      AS "sourceId",
               m."attribution"->>'headline'           AS "headline"
        FROM "Message" m
        JOIN "Conversation" conv ON conv."id" = m."conversationId"
        JOIN reached r ON r."contactId" = conv."contactId"
        WHERE m."workspaceId" = ${workspaceId}
          AND m."direction" = 'in'
          AND m."attribution" IS NOT NULL
        ORDER BY conv."contactId", m."timestamp" ASC
      )
      SELECT "source", "sourceId", MIN("headline") AS "headline", count(*) AS contacts
      FROM first_attributed
      GROUP BY "source", "sourceId"
      ORDER BY count(*) DESC
    `,
  ]);

  const totals = totalRows[0];
  const funnel = toFunnel(totals);
  const { targeted, reached, read } = funnel;

  const byBroadcast = new Map(perBroadcast.map((r) => [r.broadcastId, r]));

  // Label the accounts the recipients were actually stamped with. Read in one
  // query rather than per row, and workspace-scoped even though the ids came
  // from our own rows — a stamp is historical data, not an authorization.
  const accountIds = perAccount.map((r) => r.accountId).filter((v): v is string => v !== null);
  const accountRows = accountIds.length
    ? await db.channelConnection.findMany({
        where: { workspaceId, id: { in: accountIds } },
        select: { id: true, label: true, verifiedName: true, externalAccountId: true, channel: true },
      })
    : [];
  const accountById = new Map(accountRows.map((a) => [a.id, a]));

  return {
    campaignName,
    ...funnel,
    broadcasts: broadcasts.map((b) => ({
      id: b.id,
      name: b.name,
      channel: b.channel,
      status: b.status,
      createdAt: b.createdAt.toISOString(),
      funnel: toFunnel(byBroadcast.get(b.id)),
    })),
    accounts: perAccount
      .map((r) => {
        const acc = r.accountId ? accountById.get(r.accountId) : undefined;
        return {
          accountId: r.accountId,
          label:
            // `firstLabel`, not `??`: `ChannelConnection.label` defaults to an
            // empty string rather than null, and a nullish chain happily picks
            // that up — which is exactly what the first live run of this did,
            // rendering a real Page as a blank row in the table.
            firstLabel(acc?.label, acc?.verifiedName, acc?.externalAccountId) ??
            // A stale stamp is CORRECT (the column has no FK precisely so
            // history survives a disconnect) — so it is named as what it is
            // rather than dropped, which would make the account rows stop
            // summing to the campaign total with no visible reason.
            (r.accountId ? "Disconnected account" : "Campaign account"),
          channel: acc?.channel ?? null,
          deleted: r.accountId !== null && acc === undefined,
          funnel: toFunnel(r),
        };
      })
      // Biggest sender first. The GROUP BY returns hash order, which is stable
      // enough to look deliberate and arbitrary enough to reshuffle between two
      // loads of the same page.
      .sort((a, b) => b.funnel.targeted - a.funnel.targeted),
    failures: failures.map((f) => ({
      code: f.code,
      label: ERROR_LABELS[f.code] ?? f.code,
      bucket: failureBucket(f.code),
      metaCode: f.metaCode === null ? null : Number(f.metaCode),
      count: Number(f.count),
    })),
    cost: cost.map((c) => ({
      category: c.category,
      type: c.type,
      billable: c.billable,
      count: Number(c.count),
    })),
    sources: sources.map((s) => ({
      source: s.source ?? "unknown",
      sourceId: s.sourceId,
      headline: s.headline,
      contacts: Number(s.contacts),
    })),
    contactsReached: Number(totals?.contactsReached ?? 0),
    deliveryRate: targeted > 0 ? reached / targeted : null,
    readRate: reached > 0 ? read / reached : null,
  };
}

/** Every campaign name in the workspace, newest activity first. */
export async function listCampaigns(
  workspaceId: string,
): Promise<Array<{ campaignName: string; broadcasts: number; lastSentAt: string | null }>> {
  const rows = await db.broadcast.groupBy({
    by: ["campaignName"],
    where: { workspaceId, campaignName: { not: null } },
    _count: { _all: true },
    _max: { createdAt: true },
    // Sorted in memory rather than with an aggregate `orderBy`. A workspace has
    // tens of campaigns, not thousands, so the ordering is free here — and
    // `check:prisma-fields` cannot verify an aggregate orderBy, which makes it
    // exactly the shape that compiles clean and fails at runtime. Not worth
    // spending the guard's trust on a sort this cheap.
  });
  return rows.flatMap((r) =>
    r.campaignName
      ? [
          {
            campaignName: r.campaignName,
            broadcasts: r._count._all,
            lastSentAt: r._max.createdAt?.toISOString() ?? null,
          },
        ]
      : [],
  ).sort((a, b) => (b.lastSentAt ?? "").localeCompare(a.lastSentAt ?? ""));
}
