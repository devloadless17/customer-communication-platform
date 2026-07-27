// Note: no `server-only` import — the NestJS api process loads this on boot
// via @swc-node/register, outside the Next bundler context.

import { DelayedError, Worker, type Job } from "bullmq";
import type IORedis from "ioredis";

import { db } from "@/lib/db";
import { recordJobFailure } from "@/common/job-failure-metrics";
import {
  WORKFLOW_QUEUE_NAME,
  createWorkerConnection,
  type WorkflowJobData,
} from "@/lib/workflows/queue";
import {
  failRunFromRetryExhaustion,
  rollbackOncePerContactLedger,
  RUN_LOCK_TTL_MS,
  runWorkflow,
} from "@/lib/workflows/runner";
import { MAX_STEP_TIMEOUT_MS } from "@/lib/workflows/steps/http-request";

// BullMQ lock the worker holds for an in-flight job. MUST exceed any step's
// timeout by a safe margin, otherwise the lock expires while the step is
// still running, BullMQ re-delivers, and we double-execute side effects
// (Meta sends, tag changes, webhook POSTs). The boot-time assertion below
// catches drift if someone bumps a step timeout without bumping this.
const WORKFLOW_LOCK_DURATION_MS = 90_000;
const WORKFLOW_LOCK_MARGIN_MS = 10_000;

if (WORKFLOW_LOCK_DURATION_MS <= MAX_STEP_TIMEOUT_MS + WORKFLOW_LOCK_MARGIN_MS) {
  throw new Error(
    `[workflows] WORKFLOW_LOCK_DURATION_MS (${WORKFLOW_LOCK_DURATION_MS}) must exceed ` +
      `MAX_STEP_TIMEOUT_MS (${MAX_STEP_TIMEOUT_MS}) + ${WORKFLOW_LOCK_MARGIN_MS}ms margin. ` +
      `A step that runs to its timeout would outlive the lock and get re-delivered, ` +
      `causing duplicate side-effects. Raise WORKFLOW_LOCK_DURATION_MS or lower the cap.`,
  );
}

// The per-run mutex TTL MUST expire before BullMQ can redeliver a crashed job
// (redelivery can't happen until the job lock lapses). If a dead lane's run-lock
// outlived the redelivery, the retry would fail to acquire it, runWorkflow would
// return "skipped", BullMQ would complete the redelivery, and the run would
// strand permanently in "running". Boot-assert the ordering so a future TTL bump
// can't silently reintroduce the strand.
if (RUN_LOCK_TTL_MS >= WORKFLOW_LOCK_DURATION_MS) {
  throw new Error(
    `[workflows] RUN_LOCK_TTL_MS (${RUN_LOCK_TTL_MS}) must be < WORKFLOW_LOCK_DURATION_MS ` +
      `(${WORKFLOW_LOCK_DURATION_MS}) so a crashed lane's run-lock expires before BullMQ ` +
      `redelivers the job — otherwise the redelivery no-op-skips and the run strands in "running".`,
  );
}

/**
 * BullMQ worker for the workflow queue. Runs in-process inside the NestJS api
 * (RUN_WORKER_INLINE=1, the default); splitting into a dedicated `worker`
 * docker service is a one-line copy of the bootstrap call into a separate
 * entrypoint — the queue is shared via Redis.
 */

interface WorkerGlobals {
  worker?: Worker<WorkflowJobData>;
  connection?: IORedis;
  shuttingDown?: boolean;
}
const g = globalThis as unknown as { __ccpWorkflowWorker?: WorkerGlobals };
const state: WorkerGlobals = (g.__ccpWorkflowWorker ??= {});

function concurrency(): number {
  const raw = Number.parseInt(process.env.WORKFLOW_WORKER_CONCURRENCY ?? "5", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 5;
}

/**
 * Per-team in-process concurrency cap. Prevents one chatty team's bulk
 * operation (e.g. enrolling 1k contacts into the same workflow) from
 * monopolizing every worker slot.
 *
 * Tunable via WORKFLOW_PER_TEAM_CONCURRENCY (default 2).
 *
 * Implementation: when a job arrives for a team that's already at cap,
 * we DO NOT `await` inside the processor (that would hold the BullMQ
 * concurrency slot while parked, wasting it and starving other teams).
 * Instead we `job.moveToDelayed(now + DEFER_MS, token)` + throw a
 * `DelayedError` — BullMQ re-picks the job after the delay, the
 * concurrency slot is freed immediately for other teams' work.
 *
 * Across-process fairness needs Redis-backed slot counters (deferred —
 * single-process pilot today). Inside one process this is exact.
 */
function perTeamConcurrency(): number {
  const raw = Number.parseInt(process.env.WORKFLOW_PER_TEAM_CONCURRENCY ?? "2", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 2;
}

/** Delay before re-picking up a deferred (team-at-cap) job. */
const TEAM_BUSY_DEFER_MS = 250;

interface TeamSlotState {
  /** In-flight runs for this team. */
  active: number;
}
const teamSlots = new Map<string, TeamSlotState>();

/**
 * Try to claim a slot synchronously. Returns true on success (caller MUST
 * call `releaseTeamSlot` in a finally). Returns false if the team is at
 * cap — caller defers the job via `moveToDelayed` instead of parking.
 */
function tryAcquireTeamSlot(workspaceId: string): boolean {
  const cap = perTeamConcurrency();
  let entry = teamSlots.get(workspaceId);
  if (!entry) {
    entry = { active: 0 };
    teamSlots.set(workspaceId, entry);
  }
  if (entry.active >= cap) return false;
  entry.active += 1;
  return true;
}

function releaseTeamSlot(workspaceId: string): void {
  const entry = teamSlots.get(workspaceId);
  if (!entry) return;
  entry.active = Math.max(0, entry.active - 1);
  // Drop the entry to keep the Map bounded once a team is fully idle.
  if (entry.active === 0) {
    teamSlots.delete(workspaceId);
  }
}

export function startWorkflowWorker(): Worker<WorkflowJobData> {
  if (state.worker) return state.worker;
  state.shuttingDown = false;

  // Dedicated blocking connection (NOT the shared producer) — see
  // createWorkerConnection. Stored so stop / respawn can close it.
  const connection = createWorkerConnection("workflows-worker");
  state.connection = connection;

  const worker = new Worker<WorkflowJobData>(
    WORKFLOW_QUEUE_NAME,
    async (job: Job<WorkflowJobData>, token?: string) => {
      // Per-team concurrency gate. Look up workspaceId from the run row — the
      // job payload only carries runId. This is a single indexed read; OK
      // to do for every pickup since the alternative (workspaceId in the job
      // payload) would mean schema churn across every enqueue site.
      const run = await db.workflowRun.findUnique({
        where: { id: job.data.runId },
        select: { workspaceId: true, workflowId: true, contactId: true },
      });
      if (!run) {
        // Run was deleted between enqueue and pickup. Skip silently —
        // matches what runWorkflow does for a missing row.
        return;
      }
      if (!tryAcquireTeamSlot(run.workspaceId)) {
        // Team at cap. Push this job back into the delayed queue and
        // release the BullMQ slot immediately — other teams' work can
        // use it. BullMQ's standard pattern: moveToDelayed + throw
        // DelayedError. Doesn't count against `attempts`.
        if (token) {
          await job.moveToDelayed(Date.now() + TEAM_BUSY_DEFER_MS, token);
        }
        throw new DelayedError();
      }
      try {
        const result = await runWorkflow({
          runId: job.data.runId,
          attempt: job.attemptsMade + 1,
          // `inbound-${runId}-${tag}` jobs are early ask_question replies — the
          // runner's stale-resume guard must let them through even before
          // waitUntil. See enqueueWorkflowInboundResume + RunWorkflowInput.
          isInboundResume: (job.id ?? "").startsWith("inbound-"),
        });
        // WF-1: release the once-per-contact ledger when the run will NEVER run
        // to completion for this contact, so the contact isn't locked out
        // forever. Two cases:
        //   - status=failed: a PERMANENT failure return (loop guard, step
        //     ceiling, permanent step error — runner wrote failed and did NOT
        //     throw, so BullMQ won't retry). Throw path → failRunFromRetryExhaustion.
        //   - releaseLedger: skipped because the workflow was UNPUBLISHED or
        //     DELETED between dispatch and pickup (it never executed). Without
        //     this, a briefly-unpublished triggerOncePerContact workflow locks
        //     the contact out permanently even after re-publishing.
        // "waiting"/"completed" and the terminal/stale-resume skips keep the ledger.
        if (result?.status === "failed" || result?.releaseLedger) {
          // Re-read stepLog only on this rare terminal path (keeps the hot
          // per-pickup select lean) so the ledger release can be suppressed
          // when an irreversible side effect already fired (WF-1b). The
          // releaseLedger case (never-executed run) has an empty stepLog and
          // still releases correctly.
          const finalRun = await db.workflowRun.findUnique({
            where: { id: job.data.runId },
            select: { stepLog: true },
          });
          await rollbackOncePerContactLedger(
            run.workspaceId,
            run.workflowId,
            run.contactId,
            finalRun?.stepLog,
          );
        }
      } finally {
        releaseTeamSlot(run.workspaceId);
      }
    },
    {
      connection,
      concurrency: concurrency(),
      // BullMQ's default lock (30s) is shorter than our slowest step. A
      // `http_request` step allowed up to MAX_STEP_TIMEOUT_MS would lose
      // its lock mid-flight, get re-delivered, and execute twice — bad for
      // `tag`/`update-field`/`set-status` which mutate without an
      // idempotency key. The boot assertion above guarantees the margin.
      // `lockRenewTime` halves the lock so a step that's still alive
      // renews before the lock can expire.
      lockDuration: WORKFLOW_LOCK_DURATION_MS,
      lockRenewTime: Math.floor(WORKFLOW_LOCK_DURATION_MS / 2),
      // Explicit stalled-check tuning. BullMQ defaults `maxStalledCount=1`
      // which means a single missed lock-renewal under GC pause / pool
      // stall fails the job permanently after one stall cycle. 3 gives
      // headroom for transient blips while still surfacing genuine stuck
      // jobs in a single minute. Documents the contract so config drift
      // can't silently regress it.
      stalledInterval: 30_000,
      maxStalledCount: 3,
    },
  );

  worker.on("failed", (job, err) => {
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts.attempts ?? 1;
    console.warn(
      `[workflows] job ${job?.id} failed (attempt ${attemptsMade}/${maxAttempts}): ${err.message}`,
    );
    // Final-attempt exhaustion: the runner's `throw` path leaves the run in
    // `running` because it expects BullMQ to retry. After the last retry,
    // nobody moves the row to a terminal status — the UI shows it as
    // running forever and `workflow.run_updated` never fires `failed`.
    // failRunFromRetryExhaustion is idempotent (no-ops on already-terminal
    // runs) so calling it from this listener is safe even when the runner
    // already wrote `failed` via the StepConfigError path.
    if (job && attemptsMade >= maxAttempts) {
      recordJobFailure("workflows", job.id, err.message);
      void failRunFromRetryExhaustion(
        job.data.runId,
        `retry budget exhausted after ${attemptsMade} attempt(s): ${err.message}`,
      );
    }
  });

  worker.on("error", (err) => {
    console.error("[workflows] worker error", err);
    // Fatal error classes (ECONNRESET that BullMQ doesn't recover from,
    // auth failure with Redis) can leave the worker wedged: jobs stop
    // processing but state.worker stays set, making startWorkflowWorker() a
    // no-op. startWorkflowWorker() is called ONLY once at boot (onModuleInit);
    // no sweeper or dispatcher re-arms it. So we must self-respawn here — like
    // the send + webhook workers — otherwise one unrecoverable Redis blip
    // stalls ALL workflow processing until a manual restart. ioredis reconnects
    // the underlying socket, so the fresh Worker picks up jobs immediately.
    const msg = err instanceof Error ? err.message : String(err);
    const fatal =
      msg.includes("Connection is closed") ||
      msg.includes("WRONGPASS") ||
      msg.includes("NOAUTH");
    // Only the currently-registered worker may tear down the shared slot. A
    // superseded worker (already respawned) can emit a late fatal error while
    // its close() settles — without this guard that stale error would blank the
    // reference to the LIVE replacement worker, orphaning it (+ its ioredis
    // blocking connection) to run unreferenced and never drain on shutdown.
    if (fatal && !state.shuttingDown && state.worker === worker) {
      console.warn(
        "[workflows] worker entered unrecoverable state; re-spawning",
      );
      // Best-effort close; ignore errors since the connection is already broken.
      worker.close().catch(() => undefined);
      connection.disconnect();
      state.worker = undefined;
      state.connection = undefined;
      // Self-respawn on a short delay. Skipped during shutdown so it doesn't
      // fight stop().
      setTimeout(() => {
        if (!state.shuttingDown) startWorkflowWorker();
      }, 1_000).unref();
    }
  });

  state.worker = worker;
  console.log(`[workflows] worker started, concurrency=${concurrency()}`);
  return worker;
}

export async function stopWorkflowWorker(): Promise<void> {
  state.shuttingDown = true;
  if (!state.worker) return;
  // Hard cap on `worker.close()` so a single hung job (e.g., a step stuck
  // mid-fetch with no timeout) can't outlast compose's stop_grace_period
  // (100s on the api service) and force a SIGKILL — which would defeat the
  // whole graceful-stop point. BullMQ's own lockDuration=90s means anything
  // past 85s has already lost its lock; another worker picks it up cleanly
  // after restart.
  const closeTimeoutMs = 85_000;
  await Promise.race([
    state.worker.close(),
    new Promise<void>((_resolve, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `[workflows] worker.close() exceeded ${closeTimeoutMs}ms — abandoning drain so process can exit before SIGKILL`,
            ),
          ),
        closeTimeoutMs,
      ).unref(),
    ),
  ]).catch((err) => {
    // Log but don't re-throw — the caller's try/catch already warns and we
    // want the rest of onModuleDestroy (queue close, etc.) to still run.
    console.error(err instanceof Error ? err.message : err);
  });
  // Close the worker's dedicated blocking connection (BullMQ doesn't, since we
  // handed it the instance). disconnect() is synchronous + can't hang.
  state.connection?.disconnect();
  state.connection = undefined;
  state.worker = undefined;
}
