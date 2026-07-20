import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  forwardRef,
  Inject,
} from "@nestjs/common";
import { DelayedError, UnrecoverableError, Worker } from "bullmq";

import { recordJobFailure } from "@/common/job-failure-metrics";
import type IORedis from "ioredis";

import { publish } from "@/lib/events/bus";
import { MetaSendError, normalizeMetaSendError } from "@/lib/providers/meta";
import { flagChannelNeedsReconnect, clearChannelNeedsReconnect } from "@/lib/providers/channel-health";
import { createWorkerConnection } from "@/lib/workflows/queue";

import { MessagesService } from "./messages.service";
import { invalidateSendIdempotency } from "./send-idempotency";
import {
  MESSAGE_SEND_QUEUE_NAME,
  closeMessageSendQueue,
  type MessageSendJobData,
} from "./send-queue";

/**
 * PER-TEAM FAIRNESS for the send queue.
 *
 * `message-sends` was a flat FIFO at concurrency 5 with no tenant dimension —
 * the only one of the three job workers without a per-team gate (workflows and
 * webhook-deliver both have one). So one organisation pushing bulk sends through
 * the API, or one whose Meta credential hangs until timeout on every attempt,
 * occupied all five slots and every OTHER tenant's agent replies queued behind
 * them. That is the delay an agent actually feels ("my reply took 40 seconds"),
 * which makes it the highest-value fairness gap in the system.
 *
 * Same shape as the workflow worker: claim a slot synchronously, and if the team
 * is at cap `moveToDelayed` the job so the global slot is released immediately
 * instead of being parked. Cheaper than the workflow version, because `teamId`
 * is already on the job payload — no DB read to decide admission.
 */
function sendPerTeamConcurrency(): number {
  const raw = Number.parseInt(process.env.SEND_PER_TEAM_CONCURRENCY ?? "3", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 3;
}

const sendTeamSlots = new Map<string, { active: number }>();

function tryAcquireSendSlot(teamId: string): boolean {
  const cap = sendPerTeamConcurrency();
  let entry = sendTeamSlots.get(teamId);
  if (!entry) {
    entry = { active: 0 };
    sendTeamSlots.set(teamId, entry);
  }
  if (entry.active >= cap) return false;
  entry.active += 1;
  // The team just made progress → clear its defer-generation so a later
  // saturated burst starts escalating from the floor again.
  sendTeamDeferGen.delete(teamId);
  return true;
}

/**
 * Per-team defer-generation counter that actually drives `deferDelayMs`'s
 * escalation. `job.attemptsMade` can't: BullMQ's `moveToDelayed` uses
 * `skipAttempt`, so `attemptsMade` stays 0 across every defer and the backoff
 * would never climb off its ~250ms floor — the exact continuous re-poll churn
 * the escalating backoff exists to prevent. We bump this on each defer and
 * reset it on a successful acquire. Under saturation defers vastly outnumber
 * acquires, so it climbs to the 4s cap as designed; under light load acquires
 * keep it near zero. Deleted on acquire so the Map stays bounded by teams
 * currently in a defer-storm.
 */
const sendTeamDeferGen = new Map<string, number>();

function nextSendDeferGen(teamId: string): number {
  const n = (sendTeamDeferGen.get(teamId) ?? 0) + 1;
  sendTeamDeferGen.set(teamId, n);
  return n;
}

function releaseSendSlot(teamId: string): void {
  const entry = sendTeamSlots.get(teamId);
  if (!entry) return;
  entry.active = Math.max(0, entry.active - 1);
  // Drop the entry once idle so the Map stays bounded by ACTIVE teams, not by
  // every team that has ever sent.
  if (entry.active === 0) sendTeamSlots.delete(teamId);
}

/**
 * Backoff for a deferred (team-at-cap) job. Escalates with the team's
 * defer-generation (see `sendTeamDeferGen` — NOT `job.attemptsMade`, which never
 * advances on a defer) and adds jitter: a flat re-poll makes an over-cap
 * tenant's backlog recycle through the global slots continuously, burning the
 * very capacity the cap exists to protect and delaying the other tenants it was
 * meant to help. Jitter stops a large backlog from re-arriving in lockstep.
 */
function deferDelayMs(gen: number): number {
  const base = Math.min(250 * 2 ** Math.min(gen, 4), 4_000);
  return base + Math.floor(Math.random() * 250);
}

/**
 * Background worker that consumes the `message-sends` queue. Sole responsibility
 * is to call into `MessagesService.executeTextSendJob` and translate failures
 * into `message.send_failed` events so the originating client can flip the
 * optimistic bubble to its error state.
 *
 * Concurrency: 5 in flight, with a PER-TEAM cap on top (see below). Meta's
 * per-phone rate is ~80 msg/min, so even five concurrent workers churning
 * 200 ms-each sends well under that ceiling. Bumping concurrency higher risks
 * tripping Meta's pacing.
 *
 * Retry policy: BullMQ retries 3× on exponential backoff (configured at queue
 * creation). We classify errors first: transient (network, 5xx, "rate_limited"
 * with a Retry-After) → re-throw so BullMQ retries; permanent (24h closed,
 * auth_expired, unrecoverable Meta 4xx) → `UnrecoverableError` so BullMQ
 * stops immediately. In either case we publish `message.send_failed` first
 * so the user gets fast feedback even on a retry-eligible failure (the
 * frontend can render the failed bubble; if the retry succeeds, the swap-in
 * via `message:new` overrides it).
 */
@Injectable()
export class SendWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SendWorkerService.name);
  private worker: Worker<MessageSendJobData> | null = null;
  private connection: IORedis | null = null;
  private shuttingDown = false;

  constructor(
    // forwardRef avoids the cyclical import: MessagesService → SendWorkerService
    // (provider) and SendWorkerService → MessagesService (constructor) close
    // a Nest DI cycle that won't resolve without it.
    @Inject(forwardRef(() => MessagesService))
    private readonly messages: MessagesService,
  ) {}

  onModuleInit(): void {
    // `RUN_WORKER_INLINE=0` is the documented escape hatch (CLAUDE.md) for
    // splitting the worker into a separate container; mirror the workflow
    // worker's gate so a future deploy that re-introduces a standalone
    // worker container doesn't double-process.
    if (process.env.RUN_WORKER_INLINE === "0") {
      this.logger.log(
        "RUN_WORKER_INLINE=0 — message-sends worker disabled in this process",
      );
      return;
    }
    this.start();
  }

  /**
   * Build the worker + its dedicated blocking connection. Re-callable: the
   * fatal-error handler closes the wedged worker and calls this again (the
   * workflow worker is re-armed by its sweeper; this one re-arms itself).
   */
  private start(): void {
    // Re-entry guard. Two overlapping respawns (a Redis flap can fire the fatal
    // handler more than once before the first rebuild finishes) would otherwise
    // each construct a Worker + a dedicated blocking ioredis connection, and the
    // orphaned pair is never closed — it keeps consuming jobs and holding a
    // connection for the process's life. Every other worker in the codebase has
    // this guard (startWorkflowWorker, startBroadcastScheduleWorker,
    // startWebhookDeliverWorker); this one was the outlier.
    if (this.worker) return;
    // Dedicated blocking connection (NOT the shared producer) — see
    // createWorkerConnection in lib/workflows/queue.ts.
    const connection = createWorkerConnection("send-worker");
    this.connection = connection;
    const worker = new Worker<MessageSendJobData>(
      MESSAGE_SEND_QUEUE_NAME,
      // `job.id` is BullMQ's stable identifier — same value across all 3
      // retry attempts when a worker dies mid-job. Threaded into the
      // executor so it can write an OutboundSendAttempt row keyed on this
      // id, which prevents a mid-fetch Meta retry from double-sending.
      async (job, token) => {
        // Admission control BEFORE any work: if this team is at its cap, hand the
        // global slot straight back rather than holding it. `moveToDelayed` +
        // DelayedError is BullMQ's non-blocking defer — the job returns to the
        // queue and another tenant's send runs now.
        const teamId = job.data.teamId;
        if (!tryAcquireSendSlot(teamId)) {
          // Backoff keyed on the team's defer-generation, not job.attemptsMade
          // (which stays 0 across defers because moveToDelayed skips the attempt
          // counter) — so a saturated team's backlog actually escalates toward
          // the 4s cap instead of re-polling every ~250ms forever.
          await job.moveToDelayed(Date.now() + deferDelayMs(nextSendDeferGen(teamId)), token);
          throw new DelayedError();
        }
        try {
          return await this.handle(job.data, job.id);
        } finally {
          releaseSendSlot(teamId);
        }
      },
      {
        connection,
        concurrency: 5,
        // Same lockDuration as the workflows worker (CLAUDE.md TimeoutStopSec
        // depends on this). 90s comfortably exceeds Meta's per-call timeout
        // (~30s on a stalled endpoint) plus DB write headroom.
        lockDuration: 90_000,
        // Explicit lockRenewTime — under a stalled Meta + DB pool stall
        // chain, the in-flight handler can exceed the default 45s
        // (lockDuration/2) renewal cadence. 30s is the same value the
        // webhook worker uses and gives ~3 renewal chances per
        // lockDuration window.
        lockRenewTime: 30_000,
        // Match the other workers' stalled-check posture so config drift
        // can't silently make a transient blip permanently fail a send
        // (which OutboundSendAttempt's "refuse to retry" guard would
        // then surface as a stuck-sent ghost in the UI).
        stalledInterval: 30_000,
        maxStalledCount: 3,
      },
    );
    this.worker = worker;
    worker.on("ready", () => {
      this.logger.log("message-sends worker ready");
    });
    worker.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`worker error: ${msg}`);
      // Fatal classes (Redis socket closed, auth) leave the worker wedged with
      // this.worker still set. Close + self-respawn on a delay so sends resume
      // without operator intervention. Skipped during shutdown.
      const fatal =
        msg.includes("Connection is closed") ||
        msg.includes("WRONGPASS") ||
        msg.includes("NOAUTH");
      // Only the currently-registered worker may clear the shared slot — a late
      // error from a superseded worker must not blank the live replacement.
      if (fatal && !this.shuttingDown && this.worker === worker) {
        this.logger.warn("message-sends worker unrecoverable; re-spawning");
        worker.close().catch(() => undefined);
        this.connection?.disconnect();
        this.worker = null;
        this.connection = null;
        setTimeout(() => {
          if (!this.shuttingDown) this.start();
        }, 1_000).unref();
      }
    });
    worker.on("failed", (job, err) => {
      // Fires when a job is moved to the failed state — i.e. retries are
      // exhausted (or it threw UnrecoverableError). This is where the ACTIONABLE
      // "Failed · Retry" bubble is published for a RECOVERABLE error, NOT
      // per-attempt in handle(): publishing it while BullMQ is still going to
      // auto-retry let the agent click Retry during the backoff and double-send
      // to the customer. Non-recoverable errors already published (and showed an
      // actionable bubble) from handle() before throwing UnrecoverableError, so
      // skip those here to avoid a duplicate frame.
      const tempId =
        job?.data && "clientTempId" in job.data ? job.data.clientTempId : "<none>";
      this.logger.warn(
        `send job exhausted retries (clientTempId=${tempId}): ${
          err instanceof Error ? err.message : err
        }`,
      );
      // Terminal-failure metric (retries exhausted OR unrecoverable) for /health
      // visibility. Recorded BEFORE the UnrecoverableError early-return so a
      // permanent 4xx still counts as a job that gave up.
      if (job && (err instanceof UnrecoverableError || job.attemptsMade >= (job.opts?.attempts ?? 1))) {
        recordJobFailure("message-sends", job.id, err instanceof Error ? err.message : String(err));
      }
      if (!job || err instanceof UnrecoverableError) return;
      // Guard against per-attempt 'failed' firing (BullMQ version-dependent):
      // only publish once no more retries are coming. `< attempts` skips
      // intermediate attempts; if a runtime ever 0-indexes attemptsMade and this
      // skips the true-final attempt too, the reply-box's 30s watchdog is the
      // backstop that surfaces the failure — never a double-send.
      const attempts = job.opts?.attempts ?? 1;
      if (job.attemptsMade < attempts) return;
      const { reason, detail } = categorizeSendError(err);
      void publish({
        type: "message.send_failed",
        teamId: job.data.teamId,
        conversationId: job.data.conversationId,
        senderUserId: job.data.userId,
        ...(job.data.clientTempId ? { clientTempId: job.data.clientTempId } : {}),
        reason,
        ...(detail ? { detail } : {}),
      }).catch((pubErr) =>
        this.logger.error(
          `failed to publish exhausted send_failed event: ${pubErr instanceof Error ? pubErr.message : pubErr}`,
        ),
      );
      // Drop the cached HTTP-POST success so a same-clientTempId Retry within
      // the idempotency window re-enqueues instead of short-circuiting.
      invalidateSendIdempotency({
        teamId: job.data.teamId,
        userId: job.data.userId,
        conversationId: job.data.conversationId,
        clientTempId: job.data.clientTempId,
      });
    });
  }

  async onModuleDestroy(): Promise<void> {
    // Mirror the workflow worker's graceful-stop posture: await in-flight,
    // then release the Redis lock cleanly. The api service's compose
    // stop_grace_period (100s in docker-compose.yml) is the drain budget
    // and is sized to cover lockDuration + this drain. (Formerly systemd's
    // TimeoutStopSec=120; the ccp unit was removed 2026-05-26.)
    //
    // Hard cap on the await so a single send stuck mid-Meta-fetch can't keep
    // the close hanging until SIGKILL. Past 85s the BullMQ lock has expired
    // anyway — another worker will pick it up cleanly after restart.
    this.shuttingDown = true;
    if (this.worker) {
      const closeTimeoutMs = 85_000;
      const worker = this.worker;
      await Promise.race([
        worker.close(),
        new Promise<void>((_resolve, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `message-sends worker.close() exceeded ${closeTimeoutMs}ms — abandoning drain so process can exit before SIGKILL`,
                ),
              ),
            closeTimeoutMs,
          ).unref(),
        ),
      ]).catch((err) => {
        this.logger.warn(err instanceof Error ? err.message : String(err));
      });
      this.worker = null;
    }
    // Close the dedicated blocking connection (BullMQ doesn't close a handed-in
    // instance). disconnect() is synchronous + can't hang.
    this.connection?.disconnect();
    this.connection = null;
    // Close the lazy producer too — otherwise its ioredis socket (via the
    // shared connection options) stays bound past the worker drain and
    // delays process exit ~1-2s past stop_grace_period intent.
    await closeMessageSendQueue();
  }

  /**
   * Process one send job. On success the executor's internal publish
   * (`message.sent`) drives the bubble swap; this method just returns.
   * On failure we publish `message.send_failed` and decide whether BullMQ
   * should retry — transient → re-throw; permanent → UnrecoverableError.
   */
  private async handle(
    data: MessageSendJobData,
    jobId: string | undefined,
  ): Promise<void> {
    try {
      await this.messages.executeTextSendJob(data, jobId);
      // Send worked → the token is healthy; self-heal a stale reconnect flag
      // (no-op query when it isn't set). Covers every channel, incl. WhatsApp.
      void clearChannelNeedsReconnect(data.teamId, data.channel ?? "whatsapp");
    } catch (err) {
      const { reason, detail, recoverable } = categorizeSendError(err);

      if (!recoverable) {
        // Access token expired/revoked (Graph 190) → flag the channel so Settings
        // surfaces a "reconnect" banner. Meta's best practice: notify admins to
        // re-issue the token rather than silently retrying a dead credential.
        if (reason === "auth_expired") {
          void flagChannelNeedsReconnect(data.teamId, data.channel ?? "whatsapp");
        }
        // Permanent failure — no retry is coming, so publish the actionable
        // "Failed · Retry" bubble now and stop. (worker.on("failed") skips
        // republishing for UnrecoverableError, so there's no duplicate frame.)
        await publish({
          type: "message.send_failed",
          teamId: data.teamId,
          conversationId: data.conversationId,
          senderUserId: data.userId,
          ...(data.clientTempId ? { clientTempId: data.clientTempId } : {}),
          reason,
          ...(detail ? { detail } : {}),
        }).catch((pubErr) =>
          this.logger.error(
            `failed to publish send_failed event: ${pubErr instanceof Error ? pubErr.message : pubErr}`,
          ),
        );
        // Drop the cached HTTP-POST success so a same-clientTempId Retry within
        // the idempotency window re-enqueues instead of short-circuiting.
        invalidateSendIdempotency({
          teamId: data.teamId,
          userId: data.userId,
          conversationId: data.conversationId,
          clientTempId: data.clientTempId,
        });
        throw new UnrecoverableError(reason);
      }

      // Recoverable (transient 5xx / network / rate-limit): let BullMQ retry.
      // Deliberately DON'T publish a failed bubble here. A premature
      // "Failed · Retry" while a retry is still pending let the agent click
      // Retry during the backoff and send the message to the customer twice.
      // The optimistic bubble stays "sending" through the retries; if they all
      // fail, worker.on("failed") publishes the actionable failure on
      // exhaustion; if a retry succeeds, `message.sent` reconciles the bubble.
      throw err;
    }
  }
}

interface CategorizedError {
  reason: string;
  detail?: string;
  /** When true, BullMQ retries (transient: 5xx, network, rate-limit). */
  recoverable: boolean;
}

function categorizeSendError(err: unknown): CategorizedError {
  // NestJS HTTP exceptions thrown by the worker executor's narrow checks
  // (conversation existence + provider config). These are always non-
  // recoverable — a deleted conversation isn't going to come back, and a
  // de-configured Meta integration needs operator action, not a retry.
  if (typeof err === "object" && err !== null && "getResponse" in err) {
    const response = (err as { getResponse: () => unknown }).getResponse();
    if (typeof response === "object" && response !== null) {
      const r = response as { error?: string; detail?: string; status?: number };
      if (r.error) {
        // executeTextSendJob re-wraps Meta failures as Http exceptions
        // (UnprocessableEntity carrying Meta's httpStatus; BadGateway with
        // "send_failed" for network/unknown). This branch USED to mark every
        // such exception non-recoverable, which silently killed BullMQ's retry
        // policy for transient Meta 5xx / rate-limit / network blips — the
        // first Meta hiccup turned into a permanent red bubble. Re-derive
        // recoverability with the SAME rule as the MetaSendError branch below:
        //   - rate_limited / Meta 5xx / network fallback ("send_failed") → retry
        //   - everything else (executor guards: conversation-not-found,
        //     whatsapp_not_connected, send_in_progress_or_lost @ 409; and Meta
        //     business 4xx) → terminal (status absent or < 500).
        const recoverable =
          r.error === "rate_limited" ||
          r.error === "send_failed" ||
          (typeof r.status === "number" && r.status >= 500);
        return {
          reason: r.error,
          ...(r.detail ? { detail: r.detail } : {}),
          recoverable,
        };
      }
    }
  }

  if (err instanceof MetaSendError) {
    const norm = normalizeMetaSendError(err);
    if (norm) {
      const recoverable =
        norm.code === "rate_limited" || norm.httpStatus >= 500;
      return {
        reason: norm.code,
        detail: norm.detail ?? norm.message,
        recoverable,
      };
    }
    // Unclassified Meta error — treat as transient and let BullMQ retry.
    return {
      reason: "send_failed",
      detail: err.message,
      recoverable: true,
    };
  }

  // Network / DB / unknown — assume transient.
  return {
    reason: "send_failed",
    detail: err instanceof Error ? err.message : String(err),
    recoverable: true,
  };
}
