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
  startConversationAnalyticsDriftSweeper,
  stopConversationAnalyticsDriftSweeper,
} from "@/lib/sweepers/conversation-analytics-drift";
import {
  startAuthTableCleanupSweeper,
  stopAuthTableCleanupSweeper,
} from "@/lib/sweepers/auth-table-cleanup";
import {
  startInboundMediaSweeper,
  stopInboundMediaSweeper,
} from "@/lib/sweepers/inbound-media";
import {
  startWorkflowWaitingSweeper,
  stopWorkflowWaitingSweeper,
} from "@/lib/sweepers/workflow-waiting";
import {
  startWorkflowAwaitingReplySweeper,
  stopWorkflowAwaitingReplySweeper,
} from "@/lib/sweepers/workflow-awaiting-reply";
import {
  startOutboundWebhookDeliveryCleanup,
  stopOutboundWebhookDeliveryCleanup,
} from "@/lib/sweepers/outbound-webhook-delivery-cleanup";
import {
  startApiIdempotencyCleanupSweeper,
  stopApiIdempotencyCleanupSweeper,
} from "@/lib/sweepers/api-idempotency-cleanup";
import {
  startBlobOrphanSweeper,
  stopBlobOrphanSweeper,
} from "@/lib/sweepers/blob-orphan";
import {
  startOutboundEventRetentionSweeper,
  stopOutboundEventRetentionSweeper,
} from "@/lib/sweepers/outbound-event-retention";
import {
  startOutboundSendAttemptRetentionSweeper,
  stopOutboundSendAttemptRetentionSweeper,
} from "@/lib/sweepers/outbound-send-attempt-retention";
import {
  startWorkflowRunRetentionSweeper,
  stopWorkflowRunRetentionSweeper,
} from "@/lib/sweepers/workflow-run-retention";

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
 * Workflow step handlers publish via bus events — RealtimeFanout in this
 * process emits to clients, so steps that produce realtime updates work
 * regardless of which process the worker runs in.
 */
@Injectable()
export class WorkflowWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowWorkerService.name);
  private started = false;
  private mediaSweeperStarted = false;
  private waitingSweeperStarted = false;
  private awaitingReplySweeperStarted = false;
  private contactDriftSweeperStarted = false;
  private analyticsDriftSweeperStarted = false;
  private authCleanupSweeperStarted = false;
  private webhookDeliveryCleanupStarted = false;
  private apiIdempotencyCleanupStarted = false;
  private blobOrphanSweeperStarted = false;
  private outboundEventRetentionStarted = false;
  private outboundSendAttemptRetentionStarted = false;
  private workflowRunRetentionStarted = false;

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
      // Hourly cleanup of stale WorkflowAwaitingReply rows that the
      // ask_question step's on-resume delete missed (workflow disabled
      // mid-pause, manual DB intervention, etc.).
      startWorkflowAwaitingReplySweeper();
      this.awaitingReplySweeperStarted = true;
      this.logger.log("Workflow awaiting-reply sweeper started");
    } catch (err) {
      this.logger.error("Failed to start workflow-awaiting-reply sweeper", err);
    }
    try {
      // Daily reconciler for the `Contact.lastInboundAt` denorm — one
      // set-based UPDATE, cheap enough to run forever.
      startContactDriftSweeper();
      this.contactDriftSweeperStarted = true;
      this.logger.log("Contact lastInboundAt drift sweeper started");
    } catch (err) {
      this.logger.error("Failed to start contact-drift sweeper", err);
    }
    try {
      // Daily reconciler for the Conversation analytics MESSAGE COUNTERS
      // (incoming/outgoing), which the fire-and-forget analytics helpers can
      // drift on a swallowed error. Same set-based-UPDATE shape as the contact
      // drift sweep. F3 in docs/architecture-review-2026-05-25.md.
      startConversationAnalyticsDriftSweeper();
      this.analyticsDriftSweeperStarted = true;
      this.logger.log("Conversation analytics drift sweeper started");
    } catch (err) {
      this.logger.error("Failed to start analytics-drift sweeper", err);
    }
    try {
      // Daily delete of EXPIRED Better Auth Session + Verification rows
      // (Better Auth invalidates-on-read but never prunes). Active sessions
      // are untouched. F5 in docs/architecture-review-2026-05-25.md.
      startAuthTableCleanupSweeper();
      this.authCleanupSweeperStarted = true;
      this.logger.log("Auth-table cleanup sweeper started");
    } catch (err) {
      this.logger.error("Failed to start auth-table cleanup sweeper", err);
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
    try {
      // Weekly reclaim of provider-side blobs whose DB row delete was
      // swallowed by a transient outage. No-ops on providers without a
      // listKeys impl.
      startBlobOrphanSweeper();
      this.blobOrphanSweeperStarted = true;
      this.logger.log("Blob-orphan sweeper started");
    } catch (err) {
      this.logger.error("Failed to start blob-orphan sweeper", err);
    }
    try {
      // Daily retention on the OutboundEvent (bus outbox) table. Without
      // this every domain-event publish accumulates forever — the partial
      // drainer index degrades and pg_dump size balloons month-over-month.
      startOutboundEventRetentionSweeper();
      this.outboundEventRetentionStarted = true;
      this.logger.log("Outbound event retention sweeper started");
    } catch (err) {
      this.logger.error("Failed to start outbound-event retention sweeper", err);
    }
    try {
      // Daily retention on OutboundSendAttempt rows (the BEFORE-Meta-call
      // idempotency log for text sends). 7-day cutoff — anything older has
      // no corresponding BullMQ job left to retry, so the attempt-row's
      // double-send-prevention role is moot.
      startOutboundSendAttemptRetentionSweeper();
      this.outboundSendAttemptRetentionStarted = true;
      this.logger.log("Outbound send-attempt retention sweeper started");
    } catch (err) {
      this.logger.error(
        "Failed to start outbound-send-attempt retention sweeper",
        err,
      );
    }
    try {
      // Daily retention on WorkflowRun rows — fattest-growing table at
      // automation volume (one fat-JSON row per execution). 30-day cutoff
      // matches the runs-UI window; in-flight (queued/running/waiting) kept.
      startWorkflowRunRetentionSweeper();
      this.workflowRunRetentionStarted = true;
      this.logger.log("Workflow run retention sweeper started");
    } catch (err) {
      this.logger.error("Failed to start workflow-run retention sweeper", err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.workflowRunRetentionStarted) stopWorkflowRunRetentionSweeper();
    } catch (err) {
      this.logger.warn(
        `stopWorkflowRunRetentionSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.outboundSendAttemptRetentionStarted)
        stopOutboundSendAttemptRetentionSweeper();
    } catch (err) {
      this.logger.warn(
        `stopOutboundSendAttemptRetentionSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.outboundEventRetentionStarted) stopOutboundEventRetentionSweeper();
    } catch (err) {
      this.logger.warn(`stopOutboundEventRetentionSweeper threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.blobOrphanSweeperStarted) stopBlobOrphanSweeper();
    } catch (err) {
      this.logger.warn(`stopBlobOrphanSweeper threw: ${err instanceof Error ? err.message : err}`);
    }
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
      if (this.analyticsDriftSweeperStarted) stopConversationAnalyticsDriftSweeper();
    } catch (err) {
      this.logger.warn(
        `stopConversationAnalyticsDriftSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.authCleanupSweeperStarted) stopAuthTableCleanupSweeper();
    } catch (err) {
      this.logger.warn(
        `stopAuthTableCleanupSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }

    try {
      if (this.awaitingReplySweeperStarted) stopWorkflowAwaitingReplySweeper();
    } catch (err) {
      this.logger.warn(
        `stopWorkflowAwaitingReplySweeper threw: ${err instanceof Error ? err.message : err}`,
      );
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
    // dispatcher path opens it via getWorkflowQueue.
    try {
      await closeWorkflowQueue();
    } catch (err) {
      this.logger.warn(`closeWorkflowQueue threw: ${err instanceof Error ? err.message : err}`);
    }
  }
}
