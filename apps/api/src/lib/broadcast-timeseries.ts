import { db } from "@/lib/db";

/**
 * The campaign delivery curve — cumulative sent / delivered / read / replied
 * over the life of a send.
 *
 * WHY NOT META'S ANALYTICS: those are DAILY. A campaign that finishes in
 * twenty minutes is one point on a daily series, which tells you nothing about
 * how it actually went. This is built from `BroadcastRecipient` timestamps
 * instead, bucketed to a width the server picks from the span.
 *
 * WHY CUMULATIVE: the question a reader has is "how far along is it, and are
 * reads keeping up with deliveries" — a monotonic curve answers that at a
 * glance. Per-bucket counts answer a question nobody asked and make a bursty
 * send look broken.
 *
 * WHY BUCKETS, NEVER ROWS: a 100k campaign is 100k rows and four timestamps
 * each. Aggregating in Postgres returns a few hundred points regardless of
 * campaign size, so the payload and the render cost are bounded by the SPAN,
 * not by the audience.
 */

export interface TimeseriesPoint {
  /** Bucket start, ISO. */
  t: string;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
}

export interface BroadcastTimeseries {
  points: TimeseriesPoint[];
  /** Bucket width actually used, so the UI can label the axis honestly. */
  bucketSeconds: number;
  /** True when the campaign is still running — the last point is partial. */
  live: boolean;
}

/** Target ~120 points: dense enough to show shape, few enough to stay sharp. */
const TARGET_POINTS = 120;
const MIN_BUCKET_SEC = 60;

/**
 * Choose a bucket width from the span, snapped to a human unit.
 *
 * Snapping matters: an axis tick every 7 minutes is unreadable, and a reader
 * cannot do arithmetic on it. Every candidate here is something a person can
 * hold in their head.
 */
export function pickBucketSeconds(spanSeconds: number): number {
  const ideal = Math.max(MIN_BUCKET_SEC, spanSeconds / TARGET_POINTS);
  const steps = [60, 300, 900, 1_800, 3_600, 7_200, 21_600, 43_200, 86_400];
  for (const s of steps) if (ideal <= s) return s;
  return steps[steps.length - 1]!;
}

export async function getBroadcastTimeseries(
  workspaceId: string,
  broadcastId: string,
): Promise<BroadcastTimeseries | null> {
  // Ownership first — BroadcastRecipient has no workspaceId of its own, so
  // every query below is only safe because this proved the parent is ours.
  const broadcast = await db.broadcast.findFirst({
    where: { id: broadcastId, workspaceId },
    select: { startedAt: true, createdAt: true, completedAt: true, status: true },
  });
  if (!broadcast) return null;

  const start = broadcast.startedAt ?? broadcast.createdAt;
  const end = broadcast.completedAt ?? new Date();
  const spanSec = Math.max(60, Math.round((end.getTime() - start.getTime()) / 1000));
  const bucketSeconds = pickBucketSeconds(spanSec);

  // Each event is bucketed by ITS OWN timestamp, via a UNION ALL of four
  // streams pivoted back into one row per bucket.
  //
  // The tempting shortcut — GROUP BY the send bucket and FILTER on
  // `deliveredAt IS NOT NULL` — answers a DIFFERENT question: "of the messages
  // sent in this minute, how many were ever delivered". That attributes a
  // delivery to the minute the message was SENT, so the delivery curve would
  // trace the send curve's shape exactly and a slow carrier would be invisible.
  // What a reader wants is "how many had been delivered BY this minute", which
  // requires bucketing on `deliveredAt`.
  const rows = await db.$queryRaw<
    Array<{ bucket: number; sent: bigint; delivered: bigint; read: bigint; replied: bigint }>
  >`
    WITH events AS (
      SELECT floor(extract(epoch FROM "sentAt") / ${bucketSeconds})::bigint AS bucket,
             1 AS sent, 0 AS delivered, 0 AS read, 0 AS replied
        FROM "BroadcastRecipient"
       WHERE "broadcastId" = ${broadcastId} AND "sentAt" IS NOT NULL
      UNION ALL
      SELECT floor(extract(epoch FROM "deliveredAt") / ${bucketSeconds})::bigint,
             0, 1, 0, 0
        FROM "BroadcastRecipient"
       WHERE "broadcastId" = ${broadcastId} AND "deliveredAt" IS NOT NULL
      UNION ALL
      SELECT floor(extract(epoch FROM "readAt") / ${bucketSeconds})::bigint,
             0, 0, 1, 0
        FROM "BroadcastRecipient"
       WHERE "broadcastId" = ${broadcastId} AND "readAt" IS NOT NULL
      UNION ALL
      SELECT floor(extract(epoch FROM "repliedAt") / ${bucketSeconds})::bigint,
             0, 0, 0, 1
        FROM "BroadcastRecipient"
       WHERE "broadcastId" = ${broadcastId} AND "repliedAt" IS NOT NULL
    )
    SELECT bucket,
           sum(sent)::bigint      AS sent,
           sum(delivered)::bigint AS delivered,
           sum(read)::bigint      AS read,
           sum(replied)::bigint   AS replied
      FROM events
     GROUP BY bucket
     ORDER BY bucket
  `;

  let sent = 0;
  let delivered = 0;
  let read = 0;
  let replied = 0;
  const points: TimeseriesPoint[] = rows.map((r) => {
    sent += Number(r.sent);
    delivered += Number(r.delivered);
    read += Number(r.read);
    replied += Number(r.replied);
    return {
      t: new Date(Number(r.bucket) * bucketSeconds * 1000).toISOString(),
      sent,
      delivered,
      read,
      replied,
    };
  });

  return {
    points,
    bucketSeconds,
    // A running campaign's last bucket is still filling. The UI says so rather
    // than letting a reader mistake a partial bucket for a drop-off.
    live: broadcast.status === "running" || broadcast.status === "queued",
  };
}
