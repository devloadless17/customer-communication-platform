// BullMQ worker that fires SCHEDULED broadcasts at their `scheduledAt`.
//
// The delayed job (enqueued in schedule-queue.ts) lands here at fire time. The
// worker CAS-flips the row `scheduled` → `queued` and hands off to the existing
// `startBroadcast` runner (which only acts on `queued` rows). A canceled-while-
// scheduled broadcast was flipped to `canceled` by the cancel path AND had its
// job removed, so a late/duplicate fire matches zero rows on the CAS and is a
// no-op — no double send.
//
// Framework-agnostic (lib/), like lib/workflows/worker.ts. The NestJS
// lifecycle harness (WorkflowWorkerService) calls start/stop.

import { Worker, type Job } from "bullmq";
import type IORedis from "ioredis";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { startBroadcast } from "@/lib/broadcast-runner";
import {
  BROADCAST_SCHEDULE_QUEUE_NAME,
  createBroadcastScheduleWorkerConnection,
  type BroadcastScheduleJobData,
} from "@/lib/broadcasts/schedule-queue";

interface WorkerGlobals {
  worker?: Worker<BroadcastScheduleJobData>;
  connection?: IORedis;
  shuttingDown?: boolean;
}
const g = globalThis as unknown as { __ccpBroadcastScheduleWorker?: WorkerGlobals };
const state: WorkerGlobals = (g.__ccpBroadcastScheduleWorker ??= {});

async function fireScheduled(broadcastId: string): Promise<void> {
  // CAS: only a row STILL `scheduled` is promoted. Cancel-while-scheduled
  // already moved it to `canceled`, so this matches zero rows → no-op.
  const promoted = await db.broadcast.updateMany({
    where: { id: broadcastId, status: "scheduled" },
    data: { status: "queued" },
  });
  if (promoted.count === 0) {
    // The CAS matched nothing. Most of the time that's benign — the row was
    // canceled / deleted / already fired. But there's ONE stranding case it
    // hides: a PARTIAL first attempt that flipped scheduled→queued and then
    // died (or had its job re-delivered) before `startBroadcast` claimed the
    // row. That leaves the broadcast stuck at `queued` forever — the boot
    // reconciler is the only thing that ever picks it up. Re-fire a still-
    // `queued` row here: startBroadcast is idempotent (runBroadcast's own
    // queued→running CAS + in-process inFlightRuns dedupe), so this is a no-op
    // when a runner is already on it and a recovery otherwise.
    const cur = await db.broadcast.findUnique({
      where: { id: broadcastId },
      select: { status: true },
    });
    if (cur?.status === "queued") {
      startBroadcast(broadcastId);
    }
    return;
  }
  // Hand off to the runner FIRST (claims `queued` → `running`, sends, etc.)
  // before the cosmetic publish, so a throw in the publish path can't strand a
  // row that's already been promoted to `queued` with no runner kicked off.
  startBroadcast(broadcastId);
  // Surface the scheduled → queued flip so any open detail page updates live.
  const row = await db.broadcast.findUnique({
    where: { id: broadcastId },
    select: { teamId: true },
  });
  if (row) {
    await publish({
      type: "broadcast.status_changed",
      teamId: row.teamId,
      broadcastId,
      status: "queued",
    });
  }
}

export function startBroadcastScheduleWorker(): void {
  if (state.worker) return;
  // A fresh start (incl. a self-respawn after a fatal Redis error) clears the
  // shutdown flag — the previous stop() may have set it.
  state.shuttingDown = false;
  const connection = createBroadcastScheduleWorkerConnection();
  state.connection = connection;
  state.worker = new Worker<BroadcastScheduleJobData>(
    BROADCAST_SCHEDULE_QUEUE_NAME,
    async (job: Job<BroadcastScheduleJobData>) => {
      await fireScheduled(job.data.broadcastId);
    },
    {
      connection,
      // One scheduled broadcast firing just CAS-flips + hands off — trivial
      // work, the runner does the heavy lifting. Low concurrency is plenty.
      concurrency: 4,
      // Match every other worker's lock semantics (workflow/send/webhook
      // all use 90s lockDuration + half-of-it lockRenewTime). The previous
      // BullMQ-default 30s left a too-narrow window: under any Postgres
      // pool stall, fireScheduled's CAS+findUnique+publish+startBroadcast
      // chain could exceed 30s, the lock would expire mid-handler, BullMQ
      // would re-deliver, and a second worker would race the CAS. The
      // CAS predicate (`status: "scheduled"`) prevents double-promote
      // today, but in-process inFlightRuns dedupe only because both
      // deliveries land in the same process — a second api instance
      // would actually double-fire the broadcast.
      lockDuration: 90_000,
      lockRenewTime: 30_000,
      // Set stalledInterval + maxStalledCount explicitly so config drift
      // can't silently break the scheduler. Default is maxStalled=1 which
      // means one missed renewal fails the job permanently — for a
      // scheduled broadcast that means "row stays `scheduled`, fires never"
      // until the boot reconciler picks it up on next restart.
      stalledInterval: 30_000,
      maxStalledCount: 3,
    },
  );
  state.worker.on("failed", (job, err) => {
    console.error(
      `[broadcast-schedule] job ${job?.id} (broadcast ${job?.data.broadcastId}) failed`,
      err,
    );
  });

  state.worker.on("error", (err) => {
    console.error("[broadcast-schedule] worker error", err);
    // Fatal error classes (an ECONNRESET BullMQ can't recover from, a Redis
    // auth failure) can wedge the worker: jobs stop processing but state.worker
    // stays set, making startBroadcastScheduleWorker() a no-op. It's called
    // ONLY once at boot (onModuleInit) — no sweeper or dispatcher re-arms it —
    // so without a self-respawn here ONE unrecoverable Redis blip stalls ALL
    // scheduled-broadcast firing until a manual restart (scheduled campaigns
    // silently never go out). Mirror the workflow / send / webhook workers:
    // close the wedged worker + connection and re-spawn after 1s. ioredis
    // reconnects the underlying socket, so the fresh Worker picks up jobs
    // immediately.
    const msg = err instanceof Error ? err.message : String(err);
    const fatal =
      msg.includes("Connection is closed") ||
      msg.includes("WRONGPASS") ||
      msg.includes("NOAUTH");
    if (fatal && !state.shuttingDown) {
      console.warn(
        "[broadcast-schedule] worker entered unrecoverable state; re-spawning",
      );
      // Best-effort close; ignore errors since the connection is already broken.
      state.worker?.close().catch(() => undefined);
      connection.disconnect();
      state.worker = undefined;
      state.connection = undefined;
      // Self-respawn on a short delay. Skipped during shutdown so it doesn't
      // fight stop().
      setTimeout(() => {
        if (!state.shuttingDown) startBroadcastScheduleWorker();
      }, 1_000).unref();
    }
  });
}

export async function stopBroadcastScheduleWorker(): Promise<void> {
  // Set BEFORE close() so the 'error' listener's self-respawn can't fire
  // mid-shutdown and resurrect a worker we're trying to drain.
  state.shuttingDown = true;
  if (state.worker) {
    // Hard cap on worker.close() so a scheduled-fire handler stuck behind a
    // Postgres pool stall can't hang shutdown past compose's stop_grace_period
    // (100s on api) and force a SIGKILL — same posture as the workflow / send /
    // webhook workers (this one previously had an UNCAPPED close). The handler
    // is trivial (CAS + publish + fire-and-forget handoff), so 30s is ample; on
    // abandon, the row's CAS predicate (status="scheduled") + the boot
    // reconciler's queued-orphan recovery prevent any lost or double broadcast.
    const closeTimeoutMs = 30_000;
    const worker = state.worker;
    await Promise.race([
      worker.close(),
      new Promise<void>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `[broadcast-schedule] worker.close() exceeded ${closeTimeoutMs}ms — abandoning drain so process can exit before SIGKILL`,
              ),
            ),
          closeTimeoutMs,
        ).unref(),
      ),
    ]).catch((err) => {
      console.error(err instanceof Error ? err.message : err);
    });
    state.worker = undefined;
  }
  if (state.connection) {
    state.connection.disconnect();
    state.connection = undefined;
  }
}
