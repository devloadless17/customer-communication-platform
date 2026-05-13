// Shared BullMQ wiring for the automations queue.
//
// Lives outside the next bundler context the same way lib/socket-server.ts
// does — server.ts imports it on boot for the worker, API routes import it
// for `enqueue()`. globalThis singleton survives tsx-watch HMR.

import { Queue, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";

import type { AutomationTriggerEvent } from "@prisma/client";

/** Shape of a job in the queue. The dispatcher snapshots the trigger payload
 *  here so the worker can re-evaluate conditions without rehydrating state. */
export interface AutomationJobData {
  automationId: string;
  teamId: string;
  trigger: AutomationTriggerEvent;
  /** Snapshot of EventPayload at dispatch time — JSON-serializable. */
  payload: unknown;
  /** Optional test mode flag — surfaces in run rows so admins can filter. */
  isTest?: boolean;
}

export const AUTOMATION_QUEUE_NAME = "automations";

interface QueueGlobals {
  connection?: IORedis;
  queue?: Queue<AutomationJobData>;
}
const g = globalThis as unknown as { __ccpAutomationQueue?: QueueGlobals };
const state: QueueGlobals = (g.__ccpAutomationQueue ??= {});

function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "REDIS_URL not set. The automations queue requires Redis. " +
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
    // Don't crash the process on transient Redis errors — let BullMQ's
    // built-in reconnect handle it. We log so issues are visible.
    console.error("[automations][redis]", err.message);
  });
  return state.connection;
}

export function connectionOptions(): ConnectionOptions {
  return getRedisConnection();
}

export function getAutomationQueue(): Queue<AutomationJobData> {
  if (state.queue) return state.queue;
  state.queue = new Queue<AutomationJobData>(AUTOMATION_QUEUE_NAME, {
    connection: connectionOptions(),
    defaultJobOptions: {
      // 3 attempts: initial + 2 retries with exponential backoff.
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      // Keep run history pruned. Detailed audit lives in our AutomationRun
      // table — these are the BullMQ-internal records (job metadata).
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });
  return state.queue;
}

export interface EnqueueArgs {
  automationId: string;
  teamId: string;
  trigger: AutomationTriggerEvent;
  payload: unknown;
  isTest?: boolean;
}

/** Add a job. Caller decides retry policy by passing options at the queue level. */
export async function enqueueAutomation(args: EnqueueArgs): Promise<string> {
  const q = getAutomationQueue();
  const job = await q.add(args.trigger, {
    automationId: args.automationId,
    teamId: args.teamId,
    trigger: args.trigger,
    payload: args.payload,
    ...(args.isTest ? { isTest: true } : {}),
  });
  // jobId is always populated after add(); cast keeps TS happy without ! everywhere.
  return job.id as string;
}

/**
 * Best-effort shutdown for tests / graceful process exits. Server.ts wires
 * SIGTERM into this so docker stop doesn't leave dangling connections.
 */
export async function closeAutomationQueue(): Promise<void> {
  if (state.queue) {
    await state.queue.close();
    state.queue = undefined;
  }
  if (state.connection) {
    state.connection.disconnect();
    state.connection = undefined;
  }
}
