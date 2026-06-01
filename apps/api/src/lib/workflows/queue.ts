// Shared BullMQ wiring for the workflow runs queue.
//
// Loaded by the NestJS api process via @swc-node/register, outside the Next
// bundler context: the in-process worker imports it on boot, controllers/
// services import it for `enqueue()`. globalThis singleton survives the
// dev-watch reload.

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
    // Bound the TCP-level wait so a Redis that's silently RST-dropping
    // packets can't wedge the worker. ioredis defaults to no timeout on
    // either, so without these a network-partitioned Redis hangs forever.
    connectTimeout: 10_000,
    commandTimeout: 30_000,
  });
  state.connection.on("error", (err) => {
    console.error("[workflows][redis]", err.message);
  });
  return state.connection;
}

export function connectionOptions(): ConnectionOptions {
  return getRedisConnection();
}

/**
 * A DEDICATED connection for a BullMQ Worker's blocking commands (bzpopmin).
 * Workers must NOT share the producer connection (`getRedisConnection`, used by
 * every Queue + every enqueue) or each other's: a blocking poll stalls every
 * command queued behind it on the same socket, one dropped socket would take
 * producers + all workers down together, and `closeWorkflowQueue()`'s
 * `disconnect()` could yank a worker mid-drain. `.duplicate()` clones the
 * producer's options (maxRetriesPerRequest:null, timeouts) onto a fresh socket
 * the CALLER owns and MUST close — BullMQ never closes a connection it was
 * handed rather than created.
 */
export function createWorkerConnection(label: string): IORedis {
  const conn = getRedisConnection().duplicate();
  conn.on("error", (err) => {
    console.error(`[${label}][redis]`, err.message);
  });
  return conn;
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

/**
 * Enqueue immediately. `jobId: run-${runId}` makes the enqueue idempotent —
 * the dispatcher's retry-with-backoff (Redis hiccup tail) cannot fan out a
 * second job for the same WorkflowRun row and cause concurrent execution
 * lanes that race the in_progress journal.
 *
 * Separator is `-`, not `:` — BullMQ 5.x rejects colons in custom job IDs
 * (`Error: Custom Id cannot contain :`). Switched on 2026-05-19 after the
 * bullmq bump; the underscore form has no semantic difference.
 */
export async function enqueueWorkflowRun(runId: string): Promise<string> {
  const q = getWorkflowQueue();
  const job = await q.add("run", { runId }, { jobId: `run-${runId}` });
  return job.id as string;
}

/**
 * Enqueue with a delay — used by `wait` steps to schedule resumption AND
 * by the waiting-runs sweeper to re-enqueue stranded waits.
 *
 * jobId is `resume-${runId}-${waitSeq}` where `waitSeq` is the step-log
 * length at the moment of scheduling — monotonically increasing per run.
 * The earlier `resume-${runId}` shape was ambiguous across multiple wait
 * steps within the same run: removeOnComplete keeps completed jobs for 24h,
 * which made BullMQ skip the second wait's enqueue as a duplicate, leaving
 * the run stranded until the 60s waiting-sweeper noticed. Sweeper passes
 * the same waitSeq so its re-add on a still-delayed first wait is a no-op.
 *
 * delayMs is clamped at 1ms to keep BullMQ happy (zero would mean "now,"
 * which we'd express via enqueueWorkflowRun anyway).
 *
 * Separator is `-`, not `:` — BullMQ 5.x rejects colons in custom job IDs.
 */
export async function enqueueWorkflowResume(
  runId: string,
  delayMs: number,
  waitSeq: number,
): Promise<string> {
  const q = getWorkflowQueue();
  const job = await q.add(
    "run",
    { runId },
    { delay: Math.max(1, delayMs), jobId: `resume-${runId}-${waitSeq}` },
  );
  return job.id as string;
}

/**
 * Resume an `ask_question` step early because the contact replied. The
 * inbound-ingest hook drops the answer onto `WorkflowRun.pendingAnswer`
 * and then calls this to wake the worker immediately. `tag` is the inbound
 * message's row id — unique per (run, inbound) so a second reply from the
 * same contact doesn't collide with the still-buffered previous resume.
 *
 * The timeout's `resume-${runId}-${waitSeq}` job stays in BullMQ's delayed
 * queue; nothing cancels it when the contact replies. When it eventually
 * fires, the runner's "stale / not-yet-due resume guard" (runner.ts) no-ops
 * it if the run already advanced past the original wait (run is `waiting` at a
 * LATER `waitUntil` with no `pendingAnswer`); if the run is genuinely back on
 * an `ask_question` step it re-enters it. NOTE: BullMQ locks per-JOB, not
 * per-run, so the inbound + timeout jobs for one run are NOT mutually
 * exclusive by the lock alone — the runner-side guard is what prevents the
 * dangling timeout job from waking the run early or racing the inbound resume.
 */
export async function enqueueWorkflowInboundResume(
  runId: string,
  tag: string,
): Promise<string> {
  const q = getWorkflowQueue();
  const job = await q.add(
    "run",
    { runId },
    { delay: 1, jobId: `inbound-${runId}-${tag}` },
  );
  return job.id as string;
}

/**
 * Per-RUN mutual exclusion. BullMQ locks per-JOB, not per-run, so two jobs that
 * target the SAME WorkflowRun can execute `runWorkflow()` concurrently. The
 * canonical case is an inbound `ask_question` reply landing at the same instant
 * its dangling timeout job (`resume-${runId}-${waitSeq}`) becomes due: both jobs
 * pass the runner's terminal/stale guards and both re-execute the resume branch,
 * double-firing its side effects (duplicate WhatsApp send, duplicate tag/field
 * mutation, duplicate child-workflow dispatch — none idempotent). This Redis
 * `SET NX` lock makes a pickup single-flight per run. The lock is RENEWED by a
 * heartbeat (runWorkflow renews at TTL/3) for as long as the pickup runs, so an
 * arbitrarily long pickup — several maxed http_request steps can blow past any
 * static TTL — never lets the lock lapse mid-flight (which would let a second
 * lane, e.g. a due ask_question timeout job, acquire the freed lock and
 * double-execute). If a lane DIES holding the lock the heartbeat stops and the
 * TTL expires, so a BullMQ retry / waiting-sweeper re-runs cleanly.
 */
const RUN_LOCK_PREFIX = "wf-run-lock:";

export async function acquireWorkflowRunLock(
  runId: string,
  ttlMs: number,
): Promise<string | null> {
  // Unique token so release only deletes OUR lock (not one a successor lane
  // acquired after our TTL expired). pid + time + random is collision-safe here.
  const token = `${runId}:${process.pid}:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  const res = await getRedisConnection().set(
    `${RUN_LOCK_PREFIX}${runId}`,
    token,
    "PX",
    ttlMs,
    "NX",
  );
  return res === "OK" ? token : null;
}

// Compare-and-PEXPIRE: extend OUR lock's TTL only (no-op if a successor lane
// already holds it). The heartbeat in runWorkflow calls this while a pickup runs.
const RENEW_LOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

export async function renewWorkflowRunLock(
  runId: string,
  token: string,
  ttlMs: number,
): Promise<void> {
  await getRedisConnection()
    .eval(RENEW_LOCK_LUA, 1, `${RUN_LOCK_PREFIX}${runId}`, token, String(ttlMs))
    .catch(() => undefined);
}

// Compare-and-delete so a lane whose TTL already lapsed can't delete a
// successor's freshly-acquired lock.
const RELEASE_LOCK_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export async function releaseWorkflowRunLock(
  runId: string,
  token: string,
): Promise<void> {
  // Retry once on a transient Redis error: a SWALLOWED release would leave the
  // key holding our token for the full TTL, locking out a legitimate BullMQ
  // retry of the same run (the loser returns 'skipped' and never re-runs, so
  // the run could strand until the waiting-sweeper notices). One retry closes
  // the common blip; a true outage still self-heals via the TTL + heartbeat-stop.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await getRedisConnection().eval(
        RELEASE_LOCK_LUA,
        1,
        `${RUN_LOCK_PREFIX}${runId}`,
        token,
      );
      return;
    } catch {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 50));
    }
  }
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
