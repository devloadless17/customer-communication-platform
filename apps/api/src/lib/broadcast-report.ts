/**
 * Campaign report — the domain layer behind the broadcast detail page, the CSV
 * export, and the `/v1` report endpoint.
 *
 * ONE COMPUTATION, THREE CONSUMERS. Rates and diagnostics are derived here, on
 * the server, exactly once. If the web app computed its own rates the UI, the
 * exported spreadsheet, and a client's BI pull would drift on denominators —
 * which is the single most common source of "your numbers are wrong" tickets.
 *
 * The funnel is a QUERY, not a set of counters. `BroadcastRecipient` rows move
 * sent → delivered → read, so maintaining counters would require an atomic
 * decrement-of-previous + increment-of-next on the webhook lane or they'd stop
 * summing to totalCount — materially harder than the runner's one-way
 * queued→sent increments, and six new drift surfaces to reconcile. Instead one
 * `FILTER` aggregate rides @@index([broadcastId, deliveryState, id]) in a single
 * pass, behind a short TTL cache. Revisit only at a named cliff (report p95 > 1s).
 */

import { db } from "@/lib/db";
import { TtlCache } from "@/lib/providers/config-cache";
import { failureBucket } from "@/lib/providers/meta-send-error";

/**
 * Short-TTL cache so a campaign being watched by several agents mid-send costs
 * one aggregate per window rather than one per viewer per poll. Deliberately
 * brief: delivery/read receipts arrive continuously and the operator is
 * watching a live number.
 */
const REPORT_TTL_MS = 3_000;
const reportCache = new TtlCache<BroadcastReport>(REPORT_TTL_MS, 500);

export interface BroadcastFunnel {
  /** Every recipient row that exists for the campaign. */
  targeted: number;
  /** Not yet attempted (campaign still running / materializing). */
  pending: number;
  /** Meta rejected the API call — never entered the network. */
  failedAtSend: number;
  /** Accepted by Meta and still awaiting a delivery receipt. */
  sent: number;
  delivered: number;
  read: number;
  /** Accepted, then reported undeliverable. The "never received it" bucket. */
  undelivered: number;
  /** Accepted by Meta at least once — the billable population. */
  accepted: number;
  /** Reached the handset (delivered or read). */
  reached: number;
  /** Never reached the handset, whatever the cause. */
  neverReceived: number;
  /** Unique recipients who replied (first reply only). */
  replied: number;
  /** Unique recipients who tapped a template button. */
  clicked: number;
  /** Recipients who opted out within the campaign's window. */
  optedOut: number;
  /** Excluded at create time because they had already opted out. */
  suppressed: number;
}

export interface BroadcastRates {
  /** reached / accepted — did Meta actually get it to the phone. */
  deliveryRate: number | null;
  /** read / reached — of those that arrived, how many were opened. */
  readRate: number | null;
  /** neverReceived / targeted. */
  failureRate: number | null;
  /** replied / reached — of those who got it, how many answered. */
  replyRate: number | null;
  /** clicked / reached. */
  clickRate: number | null;
}

export interface FailureBreakdownRow {
  errorCode: string;
  label: string;
  count: number;
  /** What the operator can DO about it: retry / clean the list / leave alone. */
  bucket: "retryable" | "permanent" | "suppress";
  sampleMessage: string | null;
}

export interface ReportDiagnostic {
  severity: "warn" | "info";
  code: string;
  title: string;
  detail: string;
  /** The one thing to do about it. `filter` deep-links the recipient table. */
  action?: { label: string; filter?: string };
}

export interface BroadcastReport {
  broadcastId: string;
  funnel: BroadcastFunnel;
  rates: BroadcastRates;
  /** The team's own recent performance, so a bare "42%" has meaning. */
  benchmark: { deliveryRate: number | null; readRate: number | null; campaigns: number } | null;
  failures: FailureBreakdownRow[];
  /** Billable conversations by Meta pricing category. No currency: Meta sends a
   *  category, never a price — the operator applies their own rate card. */
  cost: { billable: number; byCategory: Array<{ category: string; count: number }> };
  diagnostics: ReportDiagnostic[];
  /** Wall-clock + throughput of the send itself. */
  throughput: { startedAt: string | null; completedAt: string | null; durationSec: number | null; perMinute: number | null };
  generatedAt: string;
}

/** Human labels for the normalized codes. Kept beside the buckets so the report,
 *  the CSV, and the API all say the same thing about the same failure. */
const ERROR_LABELS: Record<string, string> = {
  invalid_recipient: "Invalid or unreachable number",
  per_user_marketing_cap: "Meta per-user marketing cap",
  rate_limited: "Rate limited by Meta",
  template_unavailable: "Template paused or disabled",
  auth_expired: "WhatsApp connection expired",
  outside_24h_window: "Messaging window closed",
  recipient_unavailable: "Recipient blocked or deactivated",
  message_unavailable: "Referenced message unavailable",
  unsupported_message: "Unsupported message content",
  duplicate_button_title: "Duplicate button title",
  provider_rejected: "Rejected by Meta",
};

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/** Raw shape of the single-pass FILTER aggregate. */
interface FunnelRow {
  targeted: bigint;
  pending: bigint;
  failed_at_send: bigint;
  sent: bigint;
  delivered: bigint;
  read: bigint;
  undelivered: bigint;
  replied: bigint;
  clicked: bigint;
  opted_out: bigint;
  billable: bigint;
}

export async function getBroadcastReport(
  workspaceId: string,
  broadcastId: string,
): Promise<BroadcastReport | null> {
  const cacheKey = `${workspaceId}:${broadcastId}`;
  const hit = reportCache.get(cacheKey);
  if (hit) return hit;

  // workspaceId is enforced on the parent: BroadcastRecipient has no workspaceId of its
  // own (it is scoped through Broadcast), so every recipient query in this file
  // is only safe because this lookup proved ownership first.
  const broadcast = await db.broadcast.findFirst({
    where: { id: broadcastId, workspaceId },
    select: {
      id: true,
      status: true,
      totalCount: true,
      suppressedCount: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
    },
  });
  if (!broadcast) return null;

  const [funnelRows, failureRows, benchmark, categoryRows] = await Promise.all([
    // ONE pass over the campaign's recipients for the whole funnel. FILTER
    // aggregates mean Postgres reads the range once instead of seven times.
    db.$queryRaw<FunnelRow[]>`
      SELECT
        count(*)                                                    AS targeted,
        count(*) FILTER (WHERE "deliveryState" = 'pending')         AS pending,
        count(*) FILTER (WHERE "deliveryState" = 'failed_at_send')  AS failed_at_send,
        count(*) FILTER (WHERE "deliveryState" = 'sent')            AS sent,
        count(*) FILTER (WHERE "deliveryState" = 'delivered')       AS delivered,
        count(*) FILTER (WHERE "deliveryState" = 'read')            AS read,
        count(*) FILTER (WHERE "deliveryState" = 'undelivered')     AS undelivered,
        count(*) FILTER (WHERE "repliedAt" IS NOT NULL)             AS replied,
        count(*) FILTER (WHERE "clickedAt" IS NOT NULL)             AS clicked,
        count(*) FILTER (WHERE "optedOutAt" IS NOT NULL)            AS opted_out,
        count(*) FILTER (WHERE "pricingBillable")                   AS billable
      FROM "BroadcastRecipient"
      WHERE "broadcastId" = ${broadcastId}
    `,
    db.broadcastRecipient.groupBy({
      by: ["errorCode"],
      where: { broadcastId, errorCode: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { errorCode: "desc" } },
      take: 12,
    }),
    computeBenchmark(workspaceId, broadcastId),
    // Billable conversations grouped by Meta's pricing category (marketing /
    // utility / authentication / service). Counts only — see the `cost` field's
    // note on why no currency amount is stored.
    db.broadcastRecipient.groupBy({
      by: ["pricingCategory"],
      where: { broadcastId, pricingCategory: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const costByCategory = categoryRows
    .filter((r) => r.pricingCategory)
    .map((r) => ({ category: r.pricingCategory as string, count: r._count._all }));

  const f = funnelRows[0];
  const n = (v: bigint | undefined) => Number(v ?? 0n);
  const delivered = n(f?.delivered);
  const read = n(f?.read);
  const undelivered = n(f?.undelivered);
  const failedAtSend = n(f?.failed_at_send);
  const sent = n(f?.sent);
  const targeted = n(f?.targeted);

  // `read` implies delivered — a message can't be read without arriving — so
  // "reached the handset" is delivered + read, not delivered alone. Getting this
  // wrong is how a read-heavy campaign reports a nonsense delivery rate.
  const reached = delivered + read;
  const accepted = reached + undelivered + sent;
  const neverReceived = failedAtSend + undelivered;

  const funnel: BroadcastFunnel = {
    targeted,
    pending: n(f?.pending),
    failedAtSend,
    sent,
    delivered,
    read,
    undelivered,
    accepted,
    reached,
    neverReceived,
    replied: n(f?.replied),
    clicked: n(f?.clicked),
    optedOut: n(f?.opted_out),
    suppressed: broadcast.suppressedCount,
  };

  const rates: BroadcastRates = {
    deliveryRate: rate(reached, accepted),
    readRate: rate(read, reached),
    failureRate: rate(neverReceived, targeted),
    replyRate: rate(n(f?.replied), reached),
    clickRate: rate(n(f?.clicked), reached),
  };

  // Attach one example message per bucket so the operator sees Meta's actual
  // words, not just a count. Bounded to the codes we're already showing.
  const failures: FailureBreakdownRow[] = [];
  for (const row of failureRows) {
    const code = row.errorCode;
    if (!code) continue;
    const sample = await db.broadcastRecipient.findFirst({
      where: { broadcastId, errorCode: code, errorMessage: { not: null } },
      select: { errorMessage: true },
    });
    failures.push({
      errorCode: code,
      label: ERROR_LABELS[code] ?? code,
      count: row._count._all,
      bucket: failureBucket(code),
      sampleMessage: sample?.errorMessage ?? null,
    });
  }

  const startedAt = broadcast.startedAt ?? broadcast.createdAt;
  const endedAt = broadcast.completedAt;
  const durationSec = endedAt ? Math.max(1, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000)) : null;
  const attempted = accepted + failedAtSend;

  const report: BroadcastReport = {
    broadcastId,
    funnel,
    rates,
    benchmark,
    failures,
    cost: { billable: n(f?.billable), byCategory: costByCategory },
    diagnostics: deriveDiagnostics(funnel, rates, failures, benchmark),
    throughput: {
      startedAt: broadcast.startedAt?.toISOString() ?? null,
      completedAt: broadcast.completedAt?.toISOString() ?? null,
      durationSec,
      perMinute: durationSec ? Math.round((attempted / durationSec) * 60) : null,
    },
    generatedAt: new Date().toISOString(),
  };

  reportCache.set(cacheKey, report);
  return report;
}

/**
 * The team's own recent delivery/read performance, so the report can say "14
 * points below your average" instead of a context-free percentage. Restricted to
 * campaigns with a real audience — comparing against a 5-person test send would
 * produce noise the operator would (correctly) stop trusting.
 */
async function computeBenchmark(
  workspaceId: string,
  excludeId: string,
): Promise<BroadcastReport["benchmark"]> {
  const priors = await db.broadcast.findMany({
    where: {
      workspaceId,
      id: { not: excludeId },
      status: { in: ["completed", "failed"] },
      totalCount: { gte: 100 },
    },
    orderBy: { completedAt: "desc" },
    take: 5,
    select: { id: true },
  });
  if (priors.length === 0) return null;

  const rows = await db.$queryRaw<{ reached: bigint; accepted: bigint; read: bigint }[]>`
    SELECT
      count(*) FILTER (WHERE "deliveryState" IN ('delivered','read'))               AS reached,
      count(*) FILTER (WHERE "deliveryState" IN ('delivered','read','undelivered','sent')) AS accepted,
      count(*) FILTER (WHERE "deliveryState" = 'read')                              AS read
    FROM "BroadcastRecipient"
    WHERE "broadcastId" = ANY(${priors.map((p) => p.id)})
  `;
  const r = rows[0];
  if (!r) return null;
  const reached = Number(r.reached);
  const accepted = Number(r.accepted);
  return {
    deliveryRate: rate(reached, accepted),
    readRate: rate(Number(r.read), reached),
    campaigns: priors.length,
  };
}

/**
 * Turn the numbers into next actions. This is what makes the report HELPFUL
 * rather than a scoreboard: every card states why something happened and what
 * to do about it, and carries the filter that deep-links the affected people.
 *
 * Capped at three, ordered by severity then blast radius — past three, cards
 * become wallpaper and get ignored. Returns empty when nothing is wrong, so a
 * healthy campaign renders no noise at all.
 */
export function deriveDiagnostics(
  funnel: BroadcastFunnel,
  rates: BroadcastRates,
  failures: FailureBreakdownRow[],
  benchmark: BroadcastReport["benchmark"],
): ReportDiagnostic[] {
  const out: ReportDiagnostic[] = [];
  const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

  const invalid = failures.find((x) => x.errorCode === "invalid_recipient");
  if (invalid && funnel.targeted > 0 && invalid.count / funnel.targeted > 0.1) {
    out.push({
      severity: "warn",
      code: "high_invalid_numbers",
      title: `${invalid.count.toLocaleString()} numbers were invalid`,
      detail:
        "These will fail on every future campaign too, and you pay nothing to remove them. Cleaning the list now makes your next send cheaper and protects your quality rating.",
      action: { label: `Review ${invalid.count.toLocaleString()} invalid numbers`, filter: "errorCode=invalid_recipient" },
    });
  }

  const retryable = failures.filter((x) => x.bucket === "retryable");
  const retryableCount = retryable.reduce((s, x) => s + x.count, 0);
  if (retryableCount > 0) {
    out.push({
      severity: "warn",
      code: "retryable_failures",
      title: `${retryableCount.toLocaleString()} failures were temporary`,
      detail: `Caused by ${retryable.map((r) => r.label.toLowerCase()).join(", ")}. These can be safely re-sent — nothing was delivered, so no one gets it twice.`,
      action: { label: `Retry ${retryableCount.toLocaleString()} recipients`, filter: "outcome=failed" },
    });
  }

  if (funnel.reached > 0 && rates.readRate !== null && rates.readRate < 0.35) {
    out.push({
      severity: "info",
      code: "low_read_rate",
      title: `Only ${pct(rates.readRate)} of delivered messages were read`,
      detail:
        "Delivery itself was fine, so this is a content or timing problem rather than a technical one — the message reached phones but didn't earn attention.",
      action: { label: "Compare with previous campaigns" },
    });
  }

  if (
    benchmark?.readRate != null &&
    rates.readRate != null &&
    benchmark.readRate - rates.readRate > 0.1
  ) {
    out.push({
      severity: "info",
      code: "below_benchmark",
      title: `Read rate is ${Math.round((benchmark.readRate - rates.readRate) * 100)} points below your average`,
      detail: `Your last ${benchmark.campaigns} campaigns averaged ${pct(benchmark.readRate)}. Worth checking what was different about this template or audience.`,
    });
  }

  return out.slice(0, 3);
}

/** Drop a campaign's cached report — call after any write that changes it. */
export function invalidateBroadcastReport(workspaceId: string, broadcastId: string): void {
  reportCache.delete(`${workspaceId}:${broadcastId}`);
}

/**
 * Map a report "outcome" bucket to a recipient WHERE clause.
 *
 * The buckets are phrased the way an operator asks the question, not the way
 * the column is stored — `never_received` in particular is the union of
 * "rejected before sending" and "accepted then undeliverable", which is the
 * single most-asked question and should not require the user to do set
 * arithmetic across two states.
 *
 * Shared by the CSV export and the /v1 recipients endpoint so a filtered export
 * and a filtered API pull can never disagree about what a bucket means.
 */
export function recipientOutcomeWhere(filter: {
  outcome?: string;
  errorCode?: string;
}): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (filter.errorCode) where.errorCode = filter.errorCode;
  switch (filter.outcome) {
    case "never_received":
      where.deliveryState = { in: ["failed_at_send", "undelivered"] };
      break;
    case "delivered":
      // `read` implies delivered — a message cannot be read without arriving.
      where.deliveryState = { in: ["delivered", "read"] };
      break;
    case "read":
      where.deliveryState = "read";
      break;
    case "undelivered":
      where.deliveryState = "undelivered";
      break;
    case "failed":
      where.deliveryState = "failed_at_send";
      break;
    case "pending":
      where.deliveryState = { in: ["pending", "sent"] };
      break;
    case "replied":
      where.repliedAt = { not: null };
      break;
    case "clicked":
      where.clickedAt = { not: null };
      break;
    default:
      break; // "all" / unset
  }
  return where;
}
