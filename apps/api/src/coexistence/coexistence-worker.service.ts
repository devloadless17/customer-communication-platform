import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { closeHistoryQueue } from "@/lib/coexistence/history-queue";
import {
  startHistoryWorker,
  stopHistoryWorker,
} from "@/lib/coexistence/history-worker";

/**
 * BullMQ worker lifecycle harness for the WhatsApp Coexistence history
 * backfill. Mirrors WorkflowWorkerService / OutboundWebhooksWorkerService —
 * same SIGTERM-drain pattern so an in-flight history chunk finishes before the
 * process exits (re-running a partially-ingested chunk is safe anyway — every
 * message dedupes on its wamid — but a clean drain avoids the churn).
 *
 * Gated by RUN_WORKER_INLINE so a future api + dedicated-worker split can move
 * the backfill off the api process without code changes.
 */
@Injectable()
export class CoexistenceWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CoexistenceWorkerService.name);
  private started = false;

  onModuleInit(): void {
    const inline = process.env.RUN_WORKER_INLINE !== "0";
    if (!inline) {
      this.logger.log("RUN_WORKER_INLINE=0 — coexistence history worker is external");
      return;
    }
    try {
      startHistoryWorker();
      this.started = true;
      this.logger.log("Coexistence history worker started");
    } catch (err) {
      this.logger.error("Failed to start coexistence history worker", err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.started) await stopHistoryWorker();
    } catch (err) {
      this.logger.warn(
        `stopHistoryWorker threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      await closeHistoryQueue();
    } catch (err) {
      this.logger.warn(
        `closeHistoryQueue threw: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
