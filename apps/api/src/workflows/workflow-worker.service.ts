import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";

import {
  startWorkflowWorker,
  stopWorkflowWorker,
} from "@/lib/workflows/worker";
import {
  closeWorkflowQueue,
} from "@/lib/workflows/queue";
import {
  startContactDriftSweeper,
  stopContactDriftSweeper,
} from "@/lib/sweepers/contact-last-inbound-drift";
import {
  startInboundMediaSweeper,
  stopInboundMediaSweeper,
} from "@/lib/sweepers/inbound-media";
import {
  startWorkflowWaitingSweeper,
  stopWorkflowWaitingSweeper,
} from "@/lib/sweepers/workflow-waiting";
import {
  startOutboundWebhookDeliveryCleanup,
  stopOutboundWebhookDeliveryCleanup,
} from "@/lib/sweepers/outbound-webhook-delivery-cleanup";
import {
  startApiIdempotencyCleanupSweeper,
  stopApiIdempotencyCleanupSweeper,
} from "@/lib/sweepers/api-idempotency-cleanup";

/**
 * BullMQ workflow worker + inbound-media sweeper bootstrap. The actual
 * worker implementation lives in [lib/workflows/worker.ts](../../../../../lib/workflows/worker.ts)
 * and stays framework-agnostic; this service is the lifecycle harness for
 * the NestJS process.
 *
 * Gated by `RUN_WORKER_INLINE`:
 *   - "1" / unset (default) → start worker in this NestJS process.
 *   - "0"                   → expect an external dedicated worker container;
 *                              the api process serves HTTP + Socket.io only.
 *
 * During the migration window:
 *   - app  (Next.js) defaults to `RUN_WORKER_INLINE=0` after Phase 4 cutover
 *     so the Next.js side stops running the worker.
 *   - api  (NestJS)  defaults to `RUN_WORKER_INLINE=1` so the worker runs here.
 *   - worker container (separate) still works for horizontal scaling.
 *
 * Workflow step handlers that publish bus events (e.g. message.sent) work
 * fine here — the RealtimeFanout service in this process emits to clients.
 * Workflow step handlers that call lib/socket/server's emitToTeam directly
 * (broadcast-runner is the only remaining caller) won't work in this
 * process and need to be migrated to publish().
 */
@Injectable()
export class WorkflowWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowWorkerService.name);
  private started = false;
  private mediaSweeperStarted = false;
  private waitingSweeperStarted = false;
  private contactDriftSweeperStarted = false;
  private webhookDeliveryCleanupStarted = false;
  private apiIdempotencyCleanupStarted = false;

  onModuleInit(): void {
    const inline = process.env.RUN_WORKER_INLINE !== "0";
    if (!inline) {
      this.logger.log("RUN_WORKER_INLINE=0 — worker is external to this process");
      return;
    }
    try {
      startWorkflowWorker();
      this.started = true;
      this.logger.log("Workflow worker started");
    } catch (err) {
      this.logger.error("Failed to start workflow worker", err);
    }
    try {
      startInboundMediaSweeper();
      this.mediaSweeperStarted = true;
      this.logger.log("Inbound media sweeper started");
    } catch (err) {
      this.logger.error("Failed to start inbound-media sweeper", err);
    }
    try {
      // Recovers `waiting` workflow runs whose BullMQ resume job is missing
      // (process death between the DB update and the enqueue, or a Redis
      // restart without persistence). Re-enqueues at the next tick; idempotent
      // because enqueueWorkflowResume uses runId as jobId.
      startWorkflowWaitingSweeper();
      this.waitingSweeperStarted = true;
      this.logger.log("Workflow waiting-runs sweeper started");
    } catch (err) {
      this.logger.error("Failed to start workflow-waiting sweeper", err);
    }
    try {
      // Daily reconciler for the `Contact.lastInboundAt` denorm. Self-
      // disables after a week of zero drift so a healthy system pays
      // nothing for the scan.
      startContactDriftSweeper();
      this.contactDriftSweeperStarted = true;
      this.logger.log("Contact lastInboundAt drift sweeper started");
    } catch (err) {
      this.logger.error("Failed to start contact-drift sweeper", err);
    }
    try {
      // Nightly TTL on OutboundWebhookDelivery rows (default 30d). Self-
      // disables after a week of nothing to delete.
      startOutboundWebhookDeliveryCleanup();
      this.webhookDeliveryCleanupStarted = true;
      this.logger.log("Outbound webhook delivery cleanup sweeper started");
    } catch (err) {
      this.logger.error("Failed to start webhook-delivery cleanup sweeper", err);
    }
    try {
      // Hourly TTL on ApiIdempotencyKey rows. Bounded — the index on
      // expiresAt makes the delete cheap and the per-tick MAX prevents a
      // long-paused sweeper from locking the table on first wake.
      startApiIdempotencyCleanupSweeper();
      this.apiIdempotencyCleanupStarted = true;
      this.logger.log("API idempotency-key cleanup sweeper started");
    } catch (err) {
      this.logger.error("Failed to start api-idempotency cleanup sweeper", err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.apiIdempotencyCleanupStarted) stopApiIdempotencyCleanupSweeper();
    } catch (err) {
      this.logger.warn(`stopApiIdempotencyCleanupSweeper threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.webhookDeliveryCleanupStarted) stopOutboundWebhookDeliveryCleanup();
    } catch (err) {
      this.logger.warn(`stopOutboundWebhookDeliveryCleanup threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.contactDriftSweeperStarted) stopContactDriftSweeper();
    } catch (err) {
      this.logger.warn(`stopContactDriftSweeper threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.waitingSweeperStarted) stopWorkflowWaitingSweeper();
    } catch (err) {
      this.logger.warn(`stopWorkflowWaitingSweeper threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.mediaSweeperStarted) stopInboundMediaSweeper();
    } catch (err) {
      this.logger.warn(`stopInboundMediaSweeper threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.started) await stopWorkflowWorker();
    } catch (err) {
      this.logger.warn(`stopWorkflowWorker threw: ${err instanceof Error ? err.message : err}`);
    }
    // ALWAYS close the queue — both this process's worker AND any HTTP
    // dispatcher path opens it via getWorkflowQueue. Symmetric with what
    // server.ts's shutdown did pre-migration.
    try {
      await closeWorkflowQueue();
    } catch (err) {
      this.logger.warn(`closeWorkflowQueue threw: ${err instanceof Error ? err.message : err}`);
    }
  }
}
