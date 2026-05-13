// Note: no `server-only` import — server.ts loads this on boot, outside the
// Next bundler context. Same convention as lib/socket-server.ts.

import { Worker, type Job } from "bullmq";

import { runAutomation } from "@/lib/automations/runner";
import {
  AUTOMATION_QUEUE_NAME,
  connectionOptions,
  type AutomationJobData,
} from "@/lib/automations/queue";

/**
 * BullMQ worker for the automations queue.
 *
 * Lives in the same Node process as the custom server today (see server.ts).
 * That's fine for the MVP single-VPS deployment; splitting into a dedicated
 * `worker` docker service is a one-line copy of the bootstrap call into a
 * separate entrypoint (no other changes — the queue is shared via Redis).
 */

interface WorkerGlobals {
  worker?: Worker<AutomationJobData>;
}
const g = globalThis as unknown as { __ccpAutomationWorker?: WorkerGlobals };
const state: WorkerGlobals = (g.__ccpAutomationWorker ??= {});

function concurrency(): number {
  const raw = Number.parseInt(process.env.AUTOMATION_WORKER_CONCURRENCY ?? "5", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 5;
}

/** Idempotent — safe to call multiple times across HMR reloads. */
export function startAutomationWorker(): Worker<AutomationJobData> {
  if (state.worker) return state.worker;

  const worker = new Worker<AutomationJobData>(
    AUTOMATION_QUEUE_NAME,
    async (job: Job<AutomationJobData>) => {
      await runAutomation({
        automationId: job.data.automationId,
        teamId: job.data.teamId,
        trigger: job.data.trigger,
        payload: job.data.payload,
        ...(job.data.isTest ? { isTest: true } : {}),
        attempt: job.attemptsMade + 1,
      });
    },
    {
      connection: connectionOptions(),
      concurrency: concurrency(),
    },
  );

  worker.on("failed", (job, err) => {
    // Quieter than `error` — this is "a webhook gave us a 5xx", not "the
    // worker itself crashed". The AutomationRun row already captured the
    // detail; this is just a process-level breadcrumb.
    console.warn(
      `[automations] job ${job?.id} failed (attempt ${job?.attemptsMade}/${
        job?.opts.attempts ?? 1
      }): ${err.message}`,
    );
  });

  worker.on("error", (err) => {
    console.error("[automations] worker error", err);
  });

  state.worker = worker;
  console.log(`[automations] worker started, concurrency=${concurrency()}`);
  return worker;
}

export async function stopAutomationWorker(): Promise<void> {
  if (!state.worker) return;
  await state.worker.close();
  state.worker = undefined;
}
