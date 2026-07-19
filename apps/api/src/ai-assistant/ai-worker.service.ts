import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker } from "bullmq";

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

  onModuleInit(): void {
    if (process.env.RUN_WORKER_INLINE === "0") return;
    this.start();
  }

  private start(): void {
    if (this.worker) return;
    this.connection = createWorkerConnection("ai-worker");
    this.worker = new Worker<AiJob>(
      AI_QUEUE_NAME,
      async (job) => this.handle(job.data),
      {
        connection: this.connection,
        concurrency: 4,
        lockDuration: 90_000,
        lockRenewTime: 30_000,
        stalledInterval: 30_000,
        maxStalledCount: 3,
      },
    );
    this.worker.on("error", (err) =>
      this.logger.error(`ai worker error: ${err instanceof Error ? err.message : String(err)}`),
    );
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
