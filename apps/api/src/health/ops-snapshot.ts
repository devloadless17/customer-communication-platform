import type { JobType, Queue } from "bullmq";

import { getJobFailureMetrics } from "../common/job-failure-metrics";
import { DbService } from "../db/db.service";
import { getAiQueue } from "../lib/ai/queue";
import { getBroadcastMaterializeQueue } from "../lib/broadcasts/materialize-queue";
import { getHistoryQueue } from "../lib/coexistence/history-queue";
import { getContactTransferQueue } from "../lib/contact-transfer/queue";
import { ffmpegSlotStats } from "../lib/media/ffmpeg-slots";
import { getWebhookDeliverQueue } from "../lib/outbound-webhooks/queue";
import { getRedisConnection, getWorkflowQueue } from "../lib/workflows/queue";
import { getMessageSendQueue } from "../messages/send-queue";
import { computeDegradations, type OutboxLagReport } from "./health-thresholds";
import { probeRedisMemory } from "./redis-memory";
import { probeStuckBroadcasts, STUCK_BROADCAST_PROBE_MIN } from "./stuck-broadcasts";

/**
 * Operational snapshot for the super-admin Platform page.
 *
 * The ops audit's finding: failed BullMQ jobs are RETAINED for 7 days and
 * surfaced NOWHERE — the in-process `/health.jobFailures` counters reset on
 * every restart, so after a deploy even they read zero while a hundred failed
 * jobs sit in Redis. This snapshot adds the DURABLE view: per-queue
 * failed/waiting/delayed/active counts straight from BullMQ (Redis truth,
 * restart-proof), alongside the same `degraded[]` list /health computes and
 * whether ops alerts are actually configured — so "is the platform healthy?"
 * is answerable from the Platform page without SSH.
 *
 * Probes are individually time-bounded (same posture as the watchdog): a
 * wedged Redis must degrade this page to partial data, not hang it.
 */

const PROBE_TIMEOUT_MS = 2_500;
const OUTBOX_STALE_SEC = 30;

export interface QueueCounts {
  failed: number;
  waiting: number;
  delayed: number;
  active: number;
}

export interface OpsSnapshot {
  db: boolean;
  redis: boolean;
  uptimeSec: number;
  degraded: string[];
  outboxLag: OutboxLagReport;
  /** Durable per-queue counts from Redis (null = the probe failed/timed out). */
  queues: Record<string, QueueCounts | null>;
  /** In-process failure counters since boot (reset on restart — the durable
   *  truth is `queues[*].failed`). */
  jobFailuresSinceBoot: ReturnType<typeof getJobFailureMetrics>;
}

async function bounded<T>(probe: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([probe, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function queueCounts(
  // Any queue regardless of its job-data generics — only getJobCounts is used.
  get: () => Pick<Queue, "getJobCounts">,
): Promise<QueueCounts | null> {
  const states: JobType[] = ["failed", "waiting", "delayed", "active"];
  return bounded(
    (async () => {
      try {
        const c = await get().getJobCounts(...states);
        return {
          failed: c.failed ?? 0,
          waiting: c.waiting ?? 0,
          delayed: c.delayed ?? 0,
          active: c.active ?? 0,
        };
      } catch {
        return null;
      }
    })(),
    null,
  );
}

export async function buildOpsSnapshot(db: DbService): Promise<OpsSnapshot> {
  const [dbOk, redisOk, redisMemory, outboxLag, stuckBroadcasts, ...queueResults] =
    await Promise.all([
      bounded(
        db.$queryRaw`SELECT 1`.then(
          () => true,
          () => false,
        ),
        false,
      ),
      bounded(
        getRedisConnection()
          .ping()
          .then(
            (p) => p === "PONG",
            () => false,
          ),
        false,
      ),
      probeRedisMemory(getRedisConnection(), PROBE_TIMEOUT_MS),
      probeOutboxLag(db),
      probeStuckBroadcasts(db, STUCK_BROADCAST_PROBE_MIN),
      queueCounts(getWorkflowQueue),
      queueCounts(getMessageSendQueue),
      queueCounts(getWebhookDeliverQueue),
      queueCounts(getBroadcastMaterializeQueue),
      queueCounts(getAiQueue),
      queueCounts(getContactTransferQueue),
      queueCounts(getHistoryQueue),
    ]);

  const poolStats = db.getPoolStats();
  const jobFailures = getJobFailureMetrics();
  const degraded = computeDegradations({
    db: dbOk,
    redis: redisOk,
    pgPool: {
      max: poolStats.max,
      total: poolStats.total,
      idle: poolStats.idle,
      waiting: poolStats.waiting,
      saturationPercent:
        poolStats.max > 0
          ? Math.round(((poolStats.total - poolStats.idle) / poolStats.max) * 100)
          : 0,
    },
    outboxLag,
    jobFailures,
    ffmpeg: ffmpegSlotStats(),
    stuckBroadcasts,
    redisMemory,
  });

  const [workflows, messageSends, webhookDeliveries, broadcastMaterialize, ai, contactTransfer, coexistenceHistory] =
    queueResults;

  return {
    db: dbOk,
    redis: redisOk,
    uptimeSec: Math.floor(process.uptime()),
    degraded,
    outboxLag,
    queues: {
      workflows,
      "message-sends": messageSends,
      "webhook-deliveries": webhookDeliveries,
      "broadcast-materialize": broadcastMaterialize,
      ai,
      "contact-transfer": contactTransfer,
      "coexistence-history": coexistenceHistory,
    },
    jobFailuresSinceBoot: jobFailures,
  };
}

/** Same partial-index-served raw query the health controller/watchdog use. */
async function probeOutboxLag(db: DbService): Promise<OutboxLagReport> {
  return bounded(
    (async () => {
      try {
        const rows = await db.$queryRaw<Array<{ pending: number; oldest: number | null }>>`
          SELECT count(*)::int AS pending,
                 EXTRACT(EPOCH FROM (now() - MIN("createdAt")))::int AS oldest
          FROM   "OutboundEvent"
          WHERE  "publishedAt" IS NULL AND "failedAt" IS NULL
        `;
        const row = rows[0] ?? { pending: 0, oldest: null };
        return {
          pendingCount: row.pending,
          oldestPendingSec: row.oldest ?? null,
          stale: row.oldest != null && row.oldest > OUTBOX_STALE_SEC,
        };
      } catch {
        return { pendingCount: -1, oldestPendingSec: null, stale: false };
      }
    })(),
    { pendingCount: -1, oldestPendingSec: null, stale: false },
  );
}
