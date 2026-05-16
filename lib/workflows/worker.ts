// Note: no `server-only` import — server.ts loads this on boot, outside the
// Next bundler context. Same convention as lib/socket/server.ts.

import { Worker, type Job } from "bullmq";

import {
  WORKFLOW_QUEUE_NAME,
  connectionOptions,
  type WorkflowJobData,
} from "@/lib/workflows/queue";
import { runWorkflow } from "@/lib/workflows/runner";

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

export function startWorkflowWorker(): Worker<WorkflowJobData> {
  if (state.worker) return state.worker;

  const worker = new Worker<WorkflowJobData>(
    WORKFLOW_QUEUE_NAME,
    async (job: Job<WorkflowJobData>) => {
      await runWorkflow({
        runId: job.data.runId,
        attempt: job.attemptsMade + 1,
      });
    },
    {
      connection: connectionOptions(),
      concurrency: concurrency(),
    },
  );

  worker.on("failed", (job, err) => {
    console.warn(
      `[workflows] job ${job?.id} failed (attempt ${job?.attemptsMade}/${
        job?.opts.attempts ?? 1
      }): ${err.message}`,
    );
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
