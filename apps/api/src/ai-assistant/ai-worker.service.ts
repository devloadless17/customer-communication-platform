import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker } from "bullmq";

import { runMemoryExtraction } from "@/lib/ai/memory-job";
import { runAiReply } from "@/lib/ai/orchestrator";
import { AI_QUEUE_NAME, closeAiQueue, type AiJob } from "@/lib/ai/queue";
import { runSessionSummary } from "@/lib/ai/summary-job";
import { createWorkerConnection } from "@/lib/workflows/queue";

/**
 * In-process BullMQ worker for the `ai-replies` queue. Gated by
 * RUN_WORKER_INLINE like every other worker. lockDuration is generous (120s)
 * because a `reply` job spans a model call + a synchronous provider send.
 * summary/memory jobs run here too but are cheap + idempotent.
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
        lockDuration: 120_000,
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
      await Promise.race([
        this.worker.close(),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 90_000).unref();
        }),
      ]);
      this.worker = null;
    }
    this.connection?.disconnect();
    await closeAiQueue().catch(() => {});
  }
}
