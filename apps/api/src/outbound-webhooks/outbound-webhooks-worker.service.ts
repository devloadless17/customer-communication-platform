import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import {
  startWebhookDeliverWorker,
  stopWebhookDeliverWorker,
} from "@/lib/outbound-webhooks/worker";
import { closeWebhookDeliverQueue } from "@/lib/outbound-webhooks/queue";
import {
  startOrphanWebhookDeliverySweeper,
  stopOrphanWebhookDeliverySweeper,
} from "@/lib/sweepers/orphan-webhook-delivery";

/**
 * BullMQ worker lifecycle harness for outbound webhook delivery. Mirrors
 * WorkflowWorkerService — same SIGTERM-drain pattern so an in-flight
 * delivery completes before the process exits (matters because we don't
 * have at-least-once-safe dedup on the receiver end; double-fire after
 * crash would re-POST a side-effecting event).
 *
 * Gated by RUN_WORKER_INLINE so a future multi-process split (api +
 * dedicated worker container) can move webhook delivery to its own pod
 * without code changes.
 */
@Injectable()
export class OutboundWebhooksWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundWebhooksWorkerService.name);
  private started = false;

  onModuleInit(): void {
    const inline = process.env.RUN_WORKER_INLINE !== "0";
    if (!inline) {
      this.logger.log("RUN_WORKER_INLINE=0 — outbound webhook worker is external");
      return;
    }
    try {
      startWebhookDeliverWorker();
      this.started = true;
      this.logger.log("Outbound webhook delivery worker started");
    } catch (err) {
      this.logger.error("Failed to start outbound webhook worker", err);
    }
    try {
      startOrphanWebhookDeliverySweeper();
      this.logger.log("Outbound webhook orphan-delivery sweeper started");
    } catch (err) {
      this.logger.error("Failed to start orphan-delivery sweeper", err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      stopOrphanWebhookDeliverySweeper();
    } catch (err) {
      this.logger.warn(
        `stopOrphanWebhookDeliverySweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.started) await stopWebhookDeliverWorker();
    } catch (err) {
      this.logger.warn(
        `stopWebhookDeliverWorker threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      await closeWebhookDeliverQueue();
    } catch (err) {
      this.logger.warn(
        `closeWebhookDeliverQueue threw: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
