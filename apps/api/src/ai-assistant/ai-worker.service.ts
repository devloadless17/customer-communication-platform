import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { UnrecoverableError, Worker } from "bullmq";

import { recordJobFailure } from "@/common/job-failure-metrics";
import { runMemoryExtraction } from "@/lib/ai/memory-job";
import { runAiReply } from "@/lib/ai/orchestrator";
import { AI_QUEUE_NAME, closeAiQueue, type AiJob } from "@/lib/ai/queue";
import { runSessionSummary } from "@/lib/ai/summary-job";
import { createWorkerConnection } from "@/lib/workflows/queue";

/**
 * In-process BullMQ worker for the `ai-replies` queue. Gated by
 * RUN_WORKER_INLINE like every other worker. A `reply` job spans a model call
 * + a synchronous provider send; summary/memory jobs run here too but are
 * cheap + idempotent.
 *
 * lockDuration is 90s to match every other worker in the process, and that
 * ceiling is load-bearing rather than cosmetic: compose gives the api a 100s
 * stop_grace_period, and main.ts caps the whole app.close() drain at 90s. The
 * old 120s meant a reply job could still hold its lock when the drain budget
 * expired — the process exits, the lock outlives it by 20s, and the job is
 * re-claimed and RE-RUN on the next boot. For a reply job that is a second
 * model call and a second billed provider send to the same customer.
 * lockRenewTime stays at a third of the lock (BullMQ's own ratio), so a
 * genuinely long model call keeps renewing while it runs and only a job that
 * outlives the shutdown budget is affected.
 */
@Injectable()
export class AiWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiWorkerService.name);
  private worker: Worker<AiJob> | null = null;
  private connection: ReturnType<typeof createWorkerConnection> | null = null;
  private shuttingDown = false;

  onModuleInit(): void {
    if (process.env.RUN_WORKER_INLINE === "0") return;
    this.start();
  }

  private start(): void {
    if (this.worker) return;
    const connection = createWorkerConnection("ai-worker");
    this.connection = connection;
    const worker = new Worker<AiJob>(
      AI_QUEUE_NAME,
      async (job) => this.handle(job.data),
      {
        connection,
        concurrency: 4,
        lockDuration: 90_000,
        lockRenewTime: 30_000,
        stalledInterval: 30_000,
        maxStalledCount: 3,
      },
    );
    this.worker = worker;
    worker.on("error", (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`ai worker error: ${msg}`);
      // Fatal classes (Redis socket closed, auth) leave the worker wedged with
      // this.worker still set. start() runs only from onModuleInit, so without a
      // self-respawn one unrecoverable Redis blip stalls ALL AI replies/summaries/
      // memory until a manual restart — the same guard every sibling worker has
      // (send-worker, workflows, webhook-deliver). Skipped during shutdown, and
      // only the currently-registered worker may clear the shared slot so a late
      // error from a superseded worker can't blank the live replacement.
      const fatal =
        msg.includes("Connection is closed") ||
        msg.includes("WRONGPASS") ||
        msg.includes("NOAUTH");
      if (fatal && !this.shuttingDown && this.worker === worker) {
        this.logger.warn("ai worker unrecoverable; re-spawning");
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
      // Terminal AI failure (retries exhausted or UnrecoverableError) — surface
      // it on /health via recordJobFailure like every other queue, otherwise a
      // steadily failing model/provider stays silently green.
      const attempts = job?.opts.attempts ?? 1;
      if (job && (err instanceof UnrecoverableError || job.attemptsMade >= attempts)) {
        recordJobFailure(AI_QUEUE_NAME, job.id, err instanceof Error ? err.message : String(err));
      }
    });
  }

  private async handle(data: AiJob): Promise<void> {
    switch (data.kind) {
      case "reply":
        return runAiReply(data);
      case "summary":
        return runSessionSummary(data.conversationId);
      case "memory":
        return runMemoryExtraction(data.conversationId, data.inboundMessageId);
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Set before close so a fatal 'error' racing the drain can't self-respawn a
    // worker we're tearing down.
    this.shuttingDown = true;
    if (this.worker) {
      // 85s, same as the send worker: OnModuleDestroy hooks run SEQUENTIALLY,
      // so a per-worker cap equal to the FULL 90s app.close() budget leaves
      // nothing for the workers draining after this one. Past 85s the BullMQ
      // lock has expired anyway and the job is re-claimed cleanly on restart.
      await Promise.race([
        this.worker.close(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 85_000).unref();
        }),
      ]);
      this.worker = null;
    }
    this.connection?.disconnect();
    await closeAiQueue().catch(() => {});
  }
}
