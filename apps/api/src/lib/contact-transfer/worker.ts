/**
 * BullMQ worker for contact import/export jobs.
 *
 * Owns the ContactTransferJob lifecycle (status CAS, progress heartbeat,
 * terminal state) and delegates the actual work to the runners. Framework-
 * agnostic like the broadcast workers; ContactTransferWorkerService owns
 * start/stop.
 *
 * Crash safety: the status flip to `running` is a CAS, so a duplicate delivery
 * is a no-op; the import runner resumes from the persisted `processedRows`; and
 * every write it performs is individually idempotent. A worker that dies
 * mid-run leaves a `running` row whose heartbeat goes stale, which the
 * contact-transfer-artifacts sweeper fails.
 */

import { Worker, type Job } from "bullmq";
import type IORedis from "ioredis";

import type { ImportMode, ImportTagMode } from "@ccp/shared/contacts/transfer-columns";

import { recordJobFailure } from "@/common/job-failure-metrics";
import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import type { ListContactsOpts } from "@/lib/queries/contacts";

import { ExportCanceled, runContactExport } from "./export-runner";
import { ImportCanceled, ImportRejected, runContactImport } from "./import-runner";
import {
  CONTACT_TRANSFER_QUEUE_NAME,
  createContactTransferWorkerConnection,
  MAX_CONCURRENT_TRANSFERS,
  type ContactTransferJobData,
} from "./queue";

/**
 * Progress is written to the DB + socket at most this often. A 100k-row import
 * flushes 100 batches; without throttling that's 100 UPDATEs and 100 socket
 * frames for a bar that moves in single-digit percentages. 2s is well under
 * what reads as "live" and well over what costs anything.
 */
const PROGRESS_INTERVAL_MS = 2_000;

/** BullMQ lock renewal must comfortably exceed the longest gap between awaits.
 *  A 100k export page can take a few seconds; 5 minutes is generous. */
const LOCK_DURATION_MS = 5 * 60_000;

let worker: Worker<ContactTransferJobData> | null = null;
let connection: IORedis | null = null;

interface StoredOptions {
  mode?: ImportMode;
  tagMode?: ImportTagMode;
  fireAutomations?: boolean;
  mapping?: Record<string, string>;
  canManageTags?: boolean;
  /** ISO-2 country for the file's national-format numbers (import only). */
  defaultCountry?: string;
  scopeIds?: string[];
  filters?: ListContactsOpts;
}

export function startContactTransferWorker(): void {
  if (worker) return;
  connection = createContactTransferWorkerConnection();
  worker = new Worker<ContactTransferJobData>(
    CONTACT_TRANSFER_QUEUE_NAME,
    async (job: Job<ContactTransferJobData>) => {
      await handleTransfer(job.data.jobId);
    },
    {
      connection,
      concurrency: MAX_CONCURRENT_TRANSFERS,
      lockDuration: LOCK_DURATION_MS,
      // Explicit stalled-check tuning — this was the ONLY worker of the seven
      // left on BullMQ's defaults (`maxStalledCount: 1`), and the default is
      // actively wrong here.
      //
      // A stall re-executes the job while the ORIGINAL handler is still alive,
      // and `handleTransfer`'s claim CAS is `pending|running → running` —
      // deliberately admitting `running → running` so a crashed run can
      // resume. So both copies proceed, both read the same stale
      // `processedRows`, and both resume from it: in `create_and_update` that
      // re-applies every row from the cursor and re-fires every per-row
      // workflow and outbound webhook. A synchronous XLSX parse or a long GC
      // blocking the event loop past `lockRenewTime` is enough to trigger it.
      //
      // Same posture as every sibling: renew at a third of the lock, and let a
      // transient renewal blip cost a retry rather than a duplicate run.
      lockRenewTime: Math.floor(LOCK_DURATION_MS / 3),
      stalledInterval: 30_000,
      maxStalledCount: 3,
    },
  );
  worker.on("failed", (job, err) => {
    recordJobFailure(CONTACT_TRANSFER_QUEUE_NAME, job?.id ?? "unknown", err?.message ?? "unknown");
  });
}

/**
 * Hard ceiling on `worker.close()` during graceful shutdown.
 *
 * Above `LOCK_DURATION_MS` (5min) is not affordable here: Nest's
 * onModuleDestroy hooks run SEQUENTIALLY, so every worker's drain is additive
 * toward `APP_CLOSE_BUDGET_MS` (90s) and compose's `stop_grace_period` (100s).
 * This worker was the only one with NO cap at all, so a 100k import in flight
 * could consume the entire budget and every later hook — the outbox drainer's
 * 60s shutdown flush, the send-worker drain — would be skipped by the
 * fallthrough. A transfer is resumable by construction (persisted cursor +
 * counters), so abandoning its drain is cheap; starving the outbox flush is
 * not.
 */
const CLOSE_TIMEOUT_MS = 20_000;

export async function stopContactTransferWorker(): Promise<void> {
  if (worker) {
    await Promise.race([
      worker.close(),
      new Promise<void>((_resolve, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `[contact-transfer] worker.close() exceeded ${CLOSE_TIMEOUT_MS}ms — abandoning drain so the process can exit before SIGKILL (the job resumes from its persisted cursor)`,
              ),
            ),
          CLOSE_TIMEOUT_MS,
        ).unref(),
      ),
    ]).catch((err) => {
      // Log, don't re-throw — the connection close below must still run.
      console.error(err instanceof Error ? err.message : err);
    });
    worker = null;
  }
  if (connection) {
    connection.disconnect();
    connection = null;
  }
}

async function handleTransfer(jobId: string): Promise<void> {
  const row = await db.contactTransferJob.findUnique({ where: { id: jobId } });
  if (!row) return; // reaped by the sweeper — nothing to do

  // Terminal already (a retry after the job completed, or an operator cancel
  // that landed before pickup). Not an error.
  if (row.status === "completed" || row.status === "failed" || row.status === "canceled") {
    return;
  }

  // CAS pending|running → running. `running` is included so a RETRY of a job
  // that crashed mid-run can pick it back up and resume; the resume cursor is
  // what makes that safe.
  const claimed = await db.contactTransferJob.updateMany({
    where: { id: jobId, status: { in: ["pending", "running"] } },
    data: { status: "running", startedAt: row.startedAt ?? new Date(), heartbeatAt: new Date() },
  });
  if (claimed.count === 0) return;

  const options = (row.options ?? {}) as StoredOptions;
  const isCanceled = async (): Promise<boolean> => {
    const cur = await db.contactTransferJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    return cur?.status === "canceled";
  };

  let lastProgressAt = 0;
  const throttledProgress = async (patch: Record<string, unknown>): Promise<void> => {
    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    await db.contactTransferJob.update({
      where: { id: jobId },
      data: { ...patch, heartbeatAt: new Date() },
    });
    await emitProgress(jobId);
  };

  try {
    if (row.kind === "export") {
      const result = await runContactExport({
        workspaceId: row.workspaceId,
        jobId,
        format: row.format,
        scope: options.scopeIds ? { ids: options.scopeIds } : { filters: options.filters ?? {} },
        isCanceled,
        onProgress: async (processed, total) => {
          await throttledProgress({ processedRows: processed, totalRows: total });
        },
      });
      await db.contactTransferJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          artifactKey: result.artifactKey,
          artifactBytes: result.artifactBytes,
          processedRows: result.rowCount,
          totalRows: result.rowCount,
          finishedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });
    } else {
      if (!row.sourceKey) throw new ImportRejected("no_source", "The uploaded file is missing.");
      const result = await runContactImport({
        workspaceId: row.workspaceId,
        userId: row.createdByUserId,
        jobId,
        format: row.format,
        sourceKey: row.sourceKey,
        options: {
          mode: options.mode ?? "create_only",
          tagMode: options.tagMode ?? "merge",
          fireAutomations: options.fireAutomations ?? true,
          mapping: options.mapping,
          canManageTags: options.canManageTags ?? false,
          defaultCountry: options.defaultCountry,
        },
        // Resume from what a previous attempt already applied.
        resumeFrom: row.processedRows,
        resumeCounters: {
          processedRows: row.processedRows,
          created: row.created,
          updated: row.updated,
          revived: row.revived,
          skipped: row.skipped,
          failed: row.failed,
        },
        isCanceled,
        onProgress: async (c) => {
          await throttledProgress({
            processedRows: c.processedRows,
            created: c.created,
            updated: c.updated,
            revived: c.revived,
            skipped: c.skipped,
            failed: c.failed,
          });
        },
      });

      await db.contactTransferJob.update({
        where: { id: jobId },
        data: {
          status: "completed",
          processedRows: result.processedRows,
          totalRows: result.totalRows,
          created: result.created,
          updated: result.updated,
          revived: result.revived,
          skipped: result.skipped,
          failed: result.failed,
          automationsSkipped: result.automationsSkipped,
          errorArtifactKey: result.errorArtifactKey,
          errorSample: {
            errors: result.errorSample,
            unknownColumns: result.unknownColumns,
            unknownStages: result.unknownStages,
            extraSheets: result.extraSheets,
          },
          finishedAt: new Date(),
          heartbeatAt: new Date(),
        },
      });

      // ONE coalesced socket frame so every open contacts list refetches — the
      // per-row events (when they fire) carry suppressSocketFanout, and above
      // the fanout cap this is the only realtime signal there is.
      if (result.created + result.updated + result.revived > 0) {
        await publish({
          type: "contact.bulk_updated",
          workspaceId: row.workspaceId,
          // Bounded — empty above the cap. The inbox's conversation-list
          // patcher uses these to refresh contact names in place; see
          // ImportResult.touchedIds.
          contactIds: result.touchedIds,
          changeKind: "mixed",
          changedByUserId: row.createdByUserId,
        });
      }
    }
  } catch (err) {
    if (err instanceof ImportCanceled || err instanceof ExportCanceled) {
      await db.contactTransferJob.update({
        where: { id: jobId },
        data: { status: "canceled", finishedAt: new Date() },
      });
      await emitProgress(jobId);
      return; // an operator cancel is not a job failure — don't let BullMQ retry
    }

    const rejected = err instanceof ImportRejected;
    await db.contactTransferJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        error: err instanceof Error ? err.message : "The transfer failed.",
        finishedAt: new Date(),
      },
    });
    await emitProgress(jobId);
    // A REJECTION is the user's file being wrong (no phone column, over a cap);
    // retrying it twice more just burns the queue and delays the failure the
    // user is waiting to see. A genuine error (DB blip, R2 timeout) rethrows so
    // BullMQ's retries can save the run.
    if (!rejected) throw err;
    return;
  }

  await emitProgress(jobId);
}

/**
 * Push the job's current state to the initiator. Scoped to the `user:` room,
 * not the team room: nobody else needs a frame per 2 seconds for someone
 * else's export, and fanout scope in this app is deliberate (CLAUDE.md §10).
 */
async function emitProgress(jobId: string): Promise<void> {
  const row = await db.contactTransferJob.findUnique({ where: { id: jobId } });
  if (!row || !row.createdByUserId) return;
  await publish({
    type: "contact.transfer_updated",
    workspaceId: row.workspaceId,
    userId: row.createdByUserId,
    job: {
      id: row.id,
      kind: row.kind,
      format: row.format,
      status: row.status,
      filename: row.filename,
      processedRows: row.processedRows,
      totalRows: row.totalRows,
      created: row.created,
      updated: row.updated,
      revived: row.revived,
      skipped: row.skipped,
      failed: row.failed,
      automationsSkipped: row.automationsSkipped,
      hasArtifact: Boolean(row.artifactKey),
      hasErrorReport: Boolean(row.errorArtifactKey),
      error: row.error,
    },
  });
}
