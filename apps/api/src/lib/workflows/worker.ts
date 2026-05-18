// Note: no `server-only` import — server.ts loads this on boot, outside the
// Next bundler context. Same convention as lib/socket/server.ts.

import { Worker, type Job } from "bullmq";

import { db } from "@/lib/db";
import {
  WORKFLOW_QUEUE_NAME,
  connectionOptions,
  type WorkflowJobData,
} from "@/lib/workflows/queue";
import { failRunFromRetryExhaustion, runWorkflow } from "@/lib/workflows/runner";

/**
 * BullMQ worker for the workflow queue. Lives in the same Node process as
 * the custom server today (server.ts); splitting into a dedicated `worker`
 * docker service is a one-line copy of the bootstrap call into a separate
 * entrypoint — the queue is shared via Redis.
 */

interface WorkerGlobals {
  worker?: Worker<WorkflowJobData>;
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
 * grabbing all `concurrency()` worker slots and starving every other
 * tenant's runs.
 *
 * Tunable via WORKFLOW_PER_TEAM_CONCURRENCY (default 2). With 5 total
 * worker slots and 2/team, two teams can fully saturate the worker
 * before head-of-line blocking kicks in for a third — beyond that the
 * over-cap team's jobs simply wait (with their BullMQ lock released so
 * the queue keeps moving for everyone else).
 *
 * Across-process fairness needs Redis-backed slot counters (deferred —
 * single-process pilot today). Inside one process this is exact.
 */
function perTeamConcurrency(): number {
  const raw = Number.parseInt(process.env.WORKFLOW_PER_TEAM_CONCURRENCY ?? "2", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 2;
}

interface TeamSlotState {
  /** In-flight runs for this team. */
  active: number;
  /** Resolvers queued waiting for a slot. FIFO. */
  waiters: Array<() => void>;
}
const teamSlots = new Map<string, TeamSlotState>();

async function acquireTeamSlot(teamId: string): Promise<void> {
  const cap = perTeamConcurrency();
  let entry = teamSlots.get(teamId);
  if (!entry) {
    entry = { active: 0, waiters: [] };
    teamSlots.set(teamId, entry);
  }
  if (entry.active < cap) {
    entry.active += 1;
    return;
  }
  // At cap — park this acquire until a sibling run releases.
  await new Promise<void>((resolve) => {
    entry!.waiters.push(resolve);
  });
  entry.active += 1;
}

function releaseTeamSlot(teamId: string): void {
  const entry = teamSlots.get(teamId);
  if (!entry) return;
  entry.active = Math.max(0, entry.active - 1);
  const next = entry.waiters.shift();
  if (next) next();
  // Drop the entry to keep the Map bounded once a team is fully idle.
  if (entry.active === 0 && entry.waiters.length === 0) {
    teamSlots.delete(teamId);
  }
}

export function startWorkflowWorker(): Worker<WorkflowJobData> {
  if (state.worker) return state.worker;

  const worker = new Worker<WorkflowJobData>(
    WORKFLOW_QUEUE_NAME,
    async (job: Job<WorkflowJobData>) => {
      // Per-team concurrency gate. Look up teamId from the run row — the
      // job payload only carries runId. This is a single indexed read; OK
      // to do for every pickup since the alternative (teamId in the job
      // payload) would mean schema churn across every enqueue site.
      const run = await db.workflowRun.findUnique({
        where: { id: job.data.runId },
        select: { teamId: true },
      });
      if (!run) {
        // Run was deleted between enqueue and pickup. Skip silently —
        // matches what runWorkflow does for a missing row.
        return;
      }
      await acquireTeamSlot(run.teamId);
      try {
        await runWorkflow({
          runId: job.data.runId,
          attempt: job.attemptsMade + 1,
        });
      } finally {
        releaseTeamSlot(run.teamId);
      }
    },
    {
      connection: connectionOptions(),
      concurrency: concurrency(),
      // BullMQ's default lock (30s) is shorter than our slowest step. A
      // `http_request` step allowed up to 60s would lose its lock mid-flight,
      // get re-delivered, and execute twice — bad for `tag`/`update-field`/
      // `set-status` which mutate without an idempotency key. 90s comfortably
      // exceeds the slowest step we permit. `lockRenewTime` halves that so a
      // step that's still alive renews before the lock can expire.
      lockDuration: 90_000,
      lockRenewTime: 45_000,
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
      void failRunFromRetryExhaustion(
        job.data.runId,
        `retry budget exhausted after ${attemptsMade} attempt(s): ${err.message}`,
      );
    }
  });

  worker.on("error", (err) => {
    console.error("[workflows] worker error", err);
  });

  state.worker = worker;
  console.log(`[workflows] worker started, concurrency=${concurrency()}`);
  return worker;
}

export async function stopWorkflowWorker(): Promise<void> {
  if (!state.worker) return;
  await state.worker.close();
  state.worker = undefined;
}
