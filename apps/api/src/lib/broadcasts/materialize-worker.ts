// BullMQ worker that MATERIALIZES a large broadcast's recipients.
//
// A broadcast whose audience exceeds the synchronous-insert threshold is created
// `materializing` with its resolved recipients staged on the row
// (`Broadcast.materializeRecipients`). This worker chunk-inserts the
// BroadcastRecipient rows off the create HTTP path — inserting 100k rows inside
// the create transaction blows Prisma's interactive-tx budget — then CAS-flips
// the row `materializing` → `queued`, corrects `totalCount` to the actually-
// inserted count, clears the staging blob, and hands off to `startBroadcast`.
//
// Crash-safe + idempotent: createMany(skipDuplicates) over the
// @@unique([broadcastId, contactId]) makes a retry re-insert a no-op, and the
// final flip is a CAS on status="materializing" so a retry after the flip (row
// already `queued`) is a no-op too. A cancel-while-materializing is honored — the
// worker checks the row status between chunks and stops inserting.
//
// Framework-agnostic (lib/), like schedule-worker.ts. WorkflowWorkerService owns
// start/stop.

import { Prisma } from "@prisma/client";
import { Worker, type Job } from "bullmq";
import type IORedis from "ioredis";

import { db } from "@/lib/db";
import { recordJobFailure } from "@/common/job-failure-metrics";
import { publish } from "@/lib/events/bus";
import { CANCEL_RECIPIENT_MARKER, startBroadcast } from "@/lib/broadcast-runner";
import { enqueueScheduledBroadcast } from "@/lib/broadcasts/schedule-queue";
import {
  BROADCAST_MATERIALIZE_QUEUE_NAME,
  createBroadcastMaterializeWorkerConnection,
  type BroadcastMaterializeJobData,
} from "@/lib/broadcasts/materialize-queue";

/** A broadcast created <30s out is treated as "now" — mirrors the create path's
 *  SCHEDULE_LEAD_MS so a materialize that lands just before the scheduled time
 *  fires immediately rather than parking `scheduled` for a few seconds. */
const SCHEDULE_LEAD_MS = 30_000;

/** Rows per createMany — bounded so each statement is Postgres-plannable and
 *  short-lived (its own implicit tx), unlike one 100k-tuple INSERT. */
const RECIPIENT_CHUNK = 1_000;

interface WorkerGlobals {
  worker?: Worker<BroadcastMaterializeJobData>;
  connection?: IORedis;
  shuttingDown?: boolean;
}
const g = globalThis as unknown as { __ccpBroadcastMaterializeWorker?: WorkerGlobals };
const state: WorkerGlobals = (g.__ccpBroadcastMaterializeWorker ??= {});

/** One staged recipient: a contact, plus the person it targets in customer-mode. */
interface StagedRecipient {
  contactId: string;
  customerId?: string | null;
}

function parseStaged(raw: Prisma.JsonValue | null | undefined): StagedRecipient[] {
  if (!Array.isArray(raw)) return [];
  const out: StagedRecipient[] = [];
  for (const r of raw) {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      const o = r as { contactId?: unknown; customerId?: unknown };
      if (typeof o.contactId === "string") {
        out.push({
          contactId: o.contactId,
          customerId: typeof o.customerId === "string" ? o.customerId : null,
        });
      }
    }
  }
  return out;
}

export async function materializeBroadcast(broadcastId: string): Promise<void> {
  const row = await db.broadcast.findUnique({
    where: { id: broadcastId },
    select: {
      id: true,
      teamId: true,
      status: true,
      scheduledAt: true,
      materializeRecipients: true,
    },
  });
  if (!row) {
    console.warn(`[broadcast-materialize] ${broadcastId} not found`);
    return;
  }
  // Only a row STILL `materializing` is ours to process. A cancel/delete/prior
  // completion moved it elsewhere → no-op (idempotent retry lands here too).
  if (row.status !== "materializing") {
    // A cancel that raced this worker (or a crash+retry landing on an
    // already-canceled row) may have left recipients this worker inserted AFTER
    // cancel()'s one-shot finalize ran — reconcile them so a canceled large
    // broadcast's counters stay honest. No-op when there's nothing to clean up.
    if (row.status === "canceled") await reconcileCanceledMaterialize(broadcastId);
    return;
  }

  const staged = parseStaged(row.materializeRecipients);
  if (staged.length === 0) {
    // Nothing to insert — either the staging blob was already consumed+nulled by
    // a prior attempt that crashed before the flip, or a degenerate empty set.
    // Reconcile from the actual inserted rows: if any exist, finalize; else fail
    // (create() guards empty audiences, so a true 0 here is a data fault).
    const existing = await db.broadcastRecipient.count({ where: { broadcastId } });
    if (existing > 0) {
      await finalizeMaterialized(broadcastId, row.teamId, existing, row.scheduledAt);
    } else {
      await failMaterialize(
        broadcastId,
        row.teamId,
        "No recipients to materialize (staging was empty).",
      );
    }
    return;
  }

  // Chunk-insert. Each createMany is its own short-lived statement; skipDuplicates
  // over @@unique([broadcastId, contactId]) makes a retry re-insert a no-op.
  for (let i = 0; i < staged.length; i += RECIPIENT_CHUNK) {
    // Honor a cancel that landed mid-materialize: stop inserting the moment the
    // row is no longer `materializing`. Cheap status re-read per chunk (≤100
    // chunks at the 100k cap). Any rows already inserted for a now-canceled
    // broadcast are harmless — the runner never processes a canceled broadcast.
    if (i > 0) {
      const cur = await db.broadcast.findUnique({
        where: { id: broadcastId },
        select: { status: true },
      });
      if (cur?.status !== "materializing") {
        console.warn(
          `[broadcast-materialize] ${broadcastId} left materializing mid-insert (now ${cur?.status ?? "gone"}) — stopping`,
        );
        // We are the LAST writer: the chunk we just inserted may have landed
        // AFTER cancel()'s finalize, leaving those rows `queued` in a canceled
        // broadcast forever. Reconcile them here (this worker inserts no more
        // rows after returning, so nothing can slip past this).
        if (cur?.status === "canceled") await reconcileCanceledMaterialize(broadcastId);
        return;
      }
    }
    const slice = staged.slice(i, i + RECIPIENT_CHUNK);
    await db.broadcastRecipient.createMany({
      data: slice.map((r) => ({
        broadcastId,
        contactId: r.contactId,
        customerId: r.customerId ?? null,
      })),
      skipDuplicates: true,
    });
  }

  // Authoritative recipient count (skipDuplicates may have dropped dup contactIds
  // from an imperfectly-deduped audience). Corrects the provisional totalCount
  // create() stamped from the staged length.
  const inserted = await db.broadcastRecipient.count({ where: { broadcastId } });
  await finalizeMaterialized(broadcastId, row.teamId, inserted, row.scheduledAt);
}

/**
 * Finalize a materialized broadcast: set the authoritative totalCount, clear the
 * staging blob, and route to the correct next state — CAS-guarded on
 * status="materializing" so a racing cancel wins and a retry after the flip is a
 * no-op.
 *
 *  - Future scheduledAt → `scheduled`: enqueue the delayed fire (the schedule
 *    worker will flip scheduled→queued + run at time). The recipients are already
 *    inserted, so the scheduled fire is a pure trigger.
 *  - Otherwise → `queued`: hand off to the runner NOW (before the publish, so a
 *    publish throw can't strand a promoted row with no runner — mirrors the
 *    scheduled-fire path).
 */
async function finalizeMaterialized(
  broadcastId: string,
  teamId: string,
  totalCount: number,
  scheduledAt: Date | null,
): Promise<void> {
  const isFuture =
    scheduledAt !== null && scheduledAt.getTime() - Date.now() > SCHEDULE_LEAD_MS;
  const nextStatus = isFuture ? "scheduled" : "queued";
  const flipped = await db.broadcast.updateMany({
    where: { id: broadcastId, status: "materializing" },
    data: { status: nextStatus, totalCount, materializeRecipients: Prisma.DbNull },
  });
  if (flipped.count === 0) return; // canceled / already flipped by a prior attempt

  if (isFuture && scheduledAt) {
    try {
      await enqueueScheduledBroadcast(broadcastId, scheduledAt.getTime() - Date.now());
    } catch (err) {
      // Redis blip — the row stays `scheduled` and the schedule-drift sweeper /
      // boot reconciler re-enqueue it.
      console.error(
        `[broadcast-materialize] failed to enqueue scheduled fire for ${broadcastId} — sweeper will retry`,
        err,
      );
    }
  } else {
    // Fire-and-forget; .catch so a DB error in startBroadcast's pre-claim read
    // can't surface as an unhandledRejection (Node 24 --unhandled-rejections=throw).
    // A row left `queued` by a failed kick is recovered by the schedule-drift sweeper.
    void startBroadcast(broadcastId).catch((err) => {
      console.error(`[broadcast-materialize] startBroadcast(${broadcastId}) failed`, err);
    });
  }
  await publish({
    type: "broadcast.status_changed",
    teamId,
    broadcastId,
    status: nextStatus,
  });
}

/**
 * Reconcile a broadcast canceled WHILE materializing. cancel()'s one-shot
 * queued→failed finalize can miss rows this worker committed after it ran, and
 * cancel() doesn't recompute totalCount for a materializing row. Flip any
 * lingering queued→failed (same CANCEL marker cancel() uses, so retryFailed keeps
 * excluding them and the billed-send guard treats them identically), then set the
 * counters from the actual rows so `sent + failed == total`. Idempotent: a second
 * pass finds no queued rows and writes the same counts. A materializing broadcast
 * never entered the send loop, so no recipient is `sent` and none was billed.
 */
async function reconcileCanceledMaterialize(broadcastId: string): Promise<void> {
  await db.broadcastRecipient.updateMany({
    where: { broadcastId, status: "queued" },
    data: { status: "failed", errorMessage: CANCEL_RECIPIENT_MARKER },
  });
  const [total, failed, sent] = await Promise.all([
    db.broadcastRecipient.count({ where: { broadcastId } }),
    db.broadcastRecipient.count({ where: { broadcastId, status: "failed" } }),
    db.broadcastRecipient.count({ where: { broadcastId, status: "sent" } }),
  ]);
  await db.broadcast.update({
    where: { id: broadcastId },
    data: { totalCount: total, failedCount: failed, sentCount: sent },
  });
}

/** Terminal-fail a materialization that can't proceed (empty staging with no
 *  inserted rows). Mirrors the runner's fail() shape. */
async function failMaterialize(
  broadcastId: string,
  teamId: string,
  message: string,
): Promise<void> {
  const failed = await db.broadcast.updateMany({
    where: { id: broadcastId, status: "materializing" },
    data: {
      status: "failed",
      lastError: message,
      completedAt: new Date(),
      materializeRecipients: Prisma.DbNull,
    },
  });
  if (failed.count === 0) return;
  await publish({
    type: "broadcast.status_changed",
    teamId,
    broadcastId,
    status: "failed",
    error: message,
  });
}

export function startBroadcastMaterializeWorker(): void {
  if (state.worker) return;
  state.shuttingDown = false;
  const connection = createBroadcastMaterializeWorkerConnection();
  state.connection = connection;
  const worker = new Worker<BroadcastMaterializeJobData>(
    BROADCAST_MATERIALIZE_QUEUE_NAME,
    async (job: Job<BroadcastMaterializeJobData>) => {
      await materializeBroadcast(job.data.broadcastId);
    },
    {
      connection,
      // A large materialize is I/O-bound on chunked inserts; keep concurrency low
      // so several concurrent 100k jobs can't dominate the Prisma pool that the
      // live inbox + send workers also draw from.
      concurrency: 2,
      // 100k / 1k = ~100 short inserts; comfortably inside 90s. Match every other
      // worker's lock semantics; the status-CAS + skipDuplicates keep a
      // re-delivery after a lock lapse safe.
      lockDuration: 90_000,
      lockRenewTime: 30_000,
      stalledInterval: 30_000,
      maxStalledCount: 3,
    },
  );
  state.worker = worker;
  worker.on("failed", (job, err) => {
    console.error(
      `[broadcast-materialize] job ${job?.id} (broadcast ${job?.data.broadcastId}) failed`,
      err,
    );
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      recordJobFailure("broadcast-materialize", job.id, err.message);
    }
  });
  worker.on("error", (err) => {
    console.error("[broadcast-materialize] worker error", err);
    const msg = err instanceof Error ? err.message : String(err);
    const fatal =
      msg.includes("Connection is closed") ||
      msg.includes("WRONGPASS") ||
      msg.includes("NOAUTH");
    if (fatal && !state.shuttingDown && state.worker === worker) {
      console.warn("[broadcast-materialize] worker entered unrecoverable state; re-spawning");
      worker.close().catch(() => undefined);
      connection.disconnect();
      state.worker = undefined;
      state.connection = undefined;
      setTimeout(() => {
        if (!state.shuttingDown) startBroadcastMaterializeWorker();
      }, 1_000).unref();
    }
  });
}

export async function stopBroadcastMaterializeWorker(): Promise<void> {
  state.shuttingDown = true;
  if (state.worker) {
    const closeTimeoutMs = 30_000;
    const worker = state.worker;
    await Promise.race([
      worker.close(),
      new Promise<void>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `[broadcast-materialize] worker.close() exceeded ${closeTimeoutMs}ms — abandoning drain so process can exit before SIGKILL`,
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
