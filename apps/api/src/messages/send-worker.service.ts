import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  forwardRef,
  Inject,
} from "@nestjs/common";
import { UnrecoverableError, Worker } from "bullmq";
import type IORedis from "ioredis";

import { publish } from "@/lib/events/bus";
import { MetaSendError, normalizeMetaSendError } from "@/lib/providers/meta";
import { createWorkerConnection } from "@/lib/workflows/queue";

import { MessagesService } from "./messages.service";
import {
  MESSAGE_SEND_QUEUE_NAME,
  type MessageSendJobData,
} from "./send-queue";

/**
 * Background worker that consumes the `message-sends` queue. Sole responsibility
 * is to call into `MessagesService.executeTextSendJob` and translate failures
 * into `message.send_failed` events so the originating client can flip the
 * optimistic bubble to its error state.
 *
 * Concurrency: 5 in flight. Meta's per-phone rate is ~80 msg/min, so even
 * five concurrent workers churning 200 ms-each sends well under that ceiling.
 * Bumping concurrency higher risks tripping Meta's pacing — keep this in
 * lockstep with the per-tenant pacer when one lands.
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
    // Dedicated blocking connection (NOT the shared producer) — see
    // createWorkerConnection in lib/workflows/queue.ts.
    const connection = createWorkerConnection("send-worker");
    this.connection = connection;
    this.worker = new Worker<MessageSendJobData>(
      MESSAGE_SEND_QUEUE_NAME,
      // `job.id` is BullMQ's stable identifier — same value across all 3
      // retry attempts when a worker dies mid-job. Threaded into the
      // executor so it can write an OutboundSendAttempt row keyed on this
      // id, which prevents a mid-fetch Meta retry from double-sending.
      async (job) => this.handle(job.data, job.id),
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
    this.worker.on("ready", () => {
      this.logger.log("message-sends worker ready");
    });
    this.worker.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`worker error: ${msg}`);
      // Fatal classes (Redis socket closed, auth) leave the worker wedged with
      // this.worker still set. Close + self-respawn on a delay so sends resume
      // without operator intervention. Skipped during shutdown.
      const fatal =
        msg.includes("Connection is closed") ||
        msg.includes("WRONGPASS") ||
        msg.includes("NOAUTH");
      if (fatal && !this.shuttingDown) {
        this.logger.warn("message-sends worker unrecoverable; re-spawning");
        this.worker?.close().catch(() => undefined);
        this.connection?.disconnect();
        this.worker = null;
        this.connection = null;
        setTimeout(() => {
          if (!this.shuttingDown) this.start();
        }, 1_000).unref();
      }
    });
    this.worker.on("failed", (job, err) => {
      // BullMQ logs the final failure after retries are exhausted. Per-attempt
      // failure publishing happens inside `handle()` below so the user gets
      // feedback at the first attempt, not after the third retry.
      const tempId =
        job?.data && "clientTempId" in job.data ? job.data.clientTempId : "<none>";
      this.logger.warn(
        `send job exhausted retries (clientTempId=${tempId}): ${
          err instanceof Error ? err.message : err
        }`,
      );
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
    } catch (err) {
      const { reason, detail, recoverable } = categorizeSendError(err);
      // Publish first so the originating client sees the failed bubble
      // immediately, even if BullMQ later retries successfully (a retry
      // success will publish `message.sent` which the frontend reconciles
      // on top of the failed marker).
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

      if (!recoverable) {
        throw new UnrecoverableError(reason);
      }
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
      const r = response as { error?: string; detail?: string };
      if (r.error) {
        return {
          reason: r.error,
          ...(r.detail ? { detail: r.detail } : {}),
          recoverable: false,
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
