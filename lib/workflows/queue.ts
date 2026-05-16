// Shared BullMQ wiring for the workflow runs queue.
//
// Lives outside the next bundler context the same way lib/socket-server.ts
// does — server.ts imports it on boot for the worker, API routes import it
// for `enqueue()`. globalThis singleton survives tsx-watch HMR.

import { Queue, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";

/**
 * Single job in the workflow queue: "process WorkflowRun row id=X."
 *
 * The run row already carries everything else (workflowId, payload,
 * currentStepId, jumpsUsed, stepLog) so the job stays trivially small and
 * survives Redis evictions/repacks. The runner re-loads the row on each
 * pickup, which also lets a paused (waiting) run resume cleanly even if
 * the workflow definition itself changed mid-wait.
 */
export interface WorkflowJobData {
  runId: string;
}

export const WORKFLOW_QUEUE_NAME = "workflows";

interface QueueGlobals {
  connection?: IORedis;
  queue?: Queue<WorkflowJobData>;
}
const g = globalThis as unknown as { __ccpWorkflowQueue?: QueueGlobals };
const state: QueueGlobals = (g.__ccpWorkflowQueue ??= {});

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "REDIS_URL not set. The workflows queue requires Redis. " +
        "Either set REDIS_URL in .env (use redis://localhost:6380 when running " +
        "docker-compose locally) or start Redis via `docker compose up -d redis`.",
    );
  }
  return url;
}

/** Lazy connection. `maxRetriesPerRequest: null` is required by BullMQ workers. */
export function getRedisConnection(): IORedis {
  if (state.connection) return state.connection;
  state.connection = new IORedis(redisUrl(), {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  state.connection.on("error", (err) => {
    console.error("[workflows][redis]", err.message);
  });
  return state.connection;
}

export function connectionOptions(): ConnectionOptions {
  return getRedisConnection();
}

export function getWorkflowQueue(): Queue<WorkflowJobData> {
  if (state.queue) return state.queue;
  state.queue = new Queue<WorkflowJobData>(WORKFLOW_QUEUE_NAME, {
    connection: connectionOptions(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });
  return state.queue;
}

/** Enqueue immediately. */
export async function enqueueWorkflowRun(runId: string): Promise<string> {
  const q = getWorkflowQueue();
  const job = await q.add("run", { runId });
  return job.id as string;
}

/**
 * Enqueue with a delay — used by `wait` steps to schedule resumption.
 * delayMs is clamped at 1ms to keep BullMQ happy (zero would mean "now,"
 * which we'd express via enqueueWorkflowRun anyway).
 */
export async function enqueueWorkflowResume(
  runId: string,
  delayMs: number,
): Promise<string> {
  const q = getWorkflowQueue();
  const job = await q.add("run", { runId }, { delay: Math.max(1, delayMs) });
  return job.id as string;
}

export async function closeWorkflowQueue(): Promise<void> {
  if (state.queue) {
    await state.queue.close();
    state.queue = undefined;
  }
  if (state.connection) {
    state.connection.disconnect();
    state.connection = undefined;
  }
}
