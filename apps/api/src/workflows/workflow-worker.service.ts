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
  startBroadcastScheduleWorker,
  stopBroadcastScheduleWorker,
} from "@/lib/broadcasts/schedule-worker";
import { closeBroadcastScheduleQueue } from "@/lib/broadcasts/schedule-queue";
import {
  startBroadcastScheduleDriftSweeper,
  stopBroadcastScheduleDriftSweeper,
} from "@/lib/sweepers/broadcast-schedule-drift";
import {
  startBroadcastMaterializeWorker,
  stopBroadcastMaterializeWorker,
} from "@/lib/broadcasts/materialize-worker";
import {
  closeBroadcastMaterializeQueue,
} from "@/lib/broadcasts/materialize-queue";
import {
  startBroadcastMaterializeDriftSweeper,
  stopBroadcastMaterializeDriftSweeper,
} from "@/lib/sweepers/broadcast-materialize-drift";
import {
  startWhatsappHealthRefreshSweeper,
  stopWhatsappHealthRefreshSweeper,
} from "@/lib/sweepers/whatsapp-health-refresh";
import {
  startWebhookSubscriptionHealthSweeper,
  stopWebhookSubscriptionHealthSweeper,
} from "@/lib/sweepers/webhook-subscription-health";
import {
  startSubscriptionReleaseRetrySweeper,
  stopSubscriptionReleaseRetrySweeper,
} from "@/lib/sweepers/subscription-release-retry";
import {
  startTemplateAnalyticsCaptureSweeper,
  stopTemplateAnalyticsCaptureSweeper,
} from "@/lib/sweepers/template-analytics-capture";
import {
  startTemplateCatalogRefreshSweeper,
  stopTemplateCatalogRefreshSweeper,
} from "@/lib/sweepers/template-catalog-refresh";
import {
  startWorkHoursSweeper,
  stopWorkHoursSweeper,
} from "@/lib/sweepers/work-hours";
import {
  startContactDriftSweeper,
  stopContactDriftSweeper,
} from "@/lib/sweepers/contact-last-inbound-drift";
import {
  startOpenTicketCountDriftSweeper,
  stopOpenTicketCountDriftSweeper,
} from "@/lib/sweepers/open-ticket-count-drift";
import {
  startTicketLastActivityDriftSweeper,
  stopTicketLastActivityDriftSweeper,
} from "@/lib/sweepers/ticket-last-activity-drift";
import {
  setAbandonedRegistrationDestroyer,
  startAbandonedRegistrationSweeper,
  stopAbandonedRegistrationSweeper,
} from "@/lib/sweepers/abandoned-registration";
import {
  startMessageFlagCountDriftSweeper,
  stopMessageFlagCountDriftSweeper,
} from "@/lib/sweepers/message-flag-count-drift";
import {
  startCustomerLinkSweeper,
  stopCustomerLinkSweeper,
} from "@/lib/sweepers/customer-link-drift";
import {
  startAssignmentRebalanceSweeper,
  stopAssignmentRebalanceSweeper,
} from "@/lib/sweepers/assignment-rebalance";
import {
  startConversationAnalyticsDriftSweeper,
  stopConversationAnalyticsDriftSweeper,
} from "@/lib/sweepers/conversation-analytics-drift";
import {
  startBroadcastDeliveryDriftSweeper,
  stopBroadcastDeliveryDriftSweeper,
} from "@/lib/sweepers/broadcast-delivery-drift";
import {
  startAuthTableCleanupSweeper,
  stopAuthTableCleanupSweeper,
} from "@/lib/sweepers/auth-table-cleanup";
import {
  startInboundMediaSweeper,
  stopInboundMediaSweeper,
} from "@/lib/sweepers/inbound-media";
import {
  startCallRecordingSweeper,
  stopCallRecordingSweeper,
} from "@/lib/sweepers/call-recordings";
import {
  startStaleCallsSweeper,
  stopStaleCallsSweeper,
} from "@/lib/sweepers/stale-calls";
import {
  startTicketSlaBreachSweeper,
  stopTicketSlaBreachSweeper,
} from "@/lib/sweepers/ticket-sla-breach";
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
import {
  startConversationEventRetentionSweeper,
  stopConversationEventRetentionSweeper,
} from "@/lib/sweepers/conversation-event-retention";
import {
  startNotificationRetentionSweeper,
  stopNotificationRetentionSweeper,
} from "@/lib/sweepers/notification-retention";
import {
  startAgentPresenceSampler,
  stopAgentPresenceSampler,
} from "@/lib/sweepers/agent-presence-sample";
import {
  startWebchatVisitorRetentionSweeper,
  stopWebchatVisitorRetentionSweeper,
} from "@/lib/sweepers/webchat-visitor-retention";
import {
  startMessageRawPayloadRetentionSweeper,
  stopMessageRawPayloadRetentionSweeper,
} from "@/lib/sweepers/message-rawpayload-retention";
import {
  startAiRetentionSweeper,
  stopAiRetentionSweeper,
} from "@/lib/sweepers/ai-retention";
import { WorkspaceRootService } from "../workspace-settings/workspace-root.service";

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
  private callRecordingSweeperStarted = false;
  private staleCallsSweeperStarted = false;
  private ticketSlaSweeperStarted = false;
  private waitingSweeperStarted = false;
  private awaitingReplySweeperStarted = false;
  private contactDriftSweeperStarted = false;
  private customerLinkSweeperStarted = false;
  private assignmentRebalanceSweeperStarted = false;
  private analyticsDriftSweeperStarted = false;
  private messageFlagCountDriftSweeperStarted = false;
  private openTicketCountDriftSweeperStarted = false;
  private ticketLastActivityDriftSweeperStarted = false;
  private broadcastDeliveryDriftSweeperStarted = false;
  private authCleanupSweeperStarted = false;
  private webhookDeliveryCleanupStarted = false;
  private apiIdempotencyCleanupStarted = false;
  private blobOrphanSweeperStarted = false;
  private outboundEventRetentionStarted = false;
  private outboundSendAttemptRetentionStarted = false;
  private workflowRunRetentionStarted = false;
  private conversationEventRetentionStarted = false;
  private notificationRetentionStarted = false;
  private agentPresenceSamplerStarted = false;
  private webchatVisitorRetentionStarted = false;
  private aiRetentionSweeperStarted = false;
  private messageRawPayloadRetentionStarted = false;
  private broadcastScheduleWorkerStarted = false;
  private broadcastScheduleDriftSweeperStarted = false;
  private broadcastMaterializeWorkerStarted = false;
  private broadcastMaterializeDriftSweeperStarted = false;
  private whatsappHealthRefreshSweeperStarted = false;
  private webhookSubscriptionHealthSweeperStarted = false;
  private subscriptionReleaseRetrySweeperStarted = false;
  private templateCatalogRefreshStarted = false;
  private templateAnalyticsCaptureStarted = false;
  private workHoursSweeperStarted = false;
  private abandonedRegistrationSweeperStarted = false;

  constructor(private readonly workspaceRoot: WorkspaceRootService) {}

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
      // Reaps tenants minted by an unfinished registration (rows commit BEFORE
      // the OTP is sent, and the OAuth hook mints an org with no compensating
      // delete). Handed the real destroy path rather than reimplementing it.
      setAbandonedRegistrationDestroyer((organizationId, label) =>
        this.workspaceRoot.destroyOrganization(organizationId, label),
      );
      startAbandonedRegistrationSweeper();
      this.abandonedRegistrationSweeperStarted = true;
      this.logger.log("Abandoned-registration sweeper started");
    } catch (err) {
      this.logger.error("Failed to start abandoned-registration sweeper", err);
    }
    try {
      startInboundMediaSweeper();
      this.mediaSweeperStarted = true;
      this.logger.log("Inbound media sweeper started");
    } catch (err) {
      this.logger.error("Failed to start inbound-media sweeper", err);
    }
    try {
      startCallRecordingSweeper();
      this.callRecordingSweeperStarted = true;
      this.logger.log("Call-recording sweeper started");
    } catch (err) {
      this.logger.error("Failed to start call-recording sweeper", err);
    }
    try {
      // Backstop that terminalizes Call rows stuck `ringing`/`in_progress`
      // (a permanently-dropped terminate webhook or an unanswered inbound ring
      // with no browser /end). Without it the team "Calls" badge sticks at ≥1
      // forever — the unread-counter stuck-badge bug class.
      startStaleCallsSweeper();
      this.staleCallsSweeperStarted = true;
      this.logger.log("Stale-calls sweeper started");
    } catch (err) {
      this.logger.error("Failed to start stale-calls sweeper", err);
    }
    try {
      // An SLA breach is time-based with no request behind it — the deadline
      // just passes. Nothing but a sweeper can notice.
      startTicketSlaBreachSweeper();
      this.ticketSlaSweeperStarted = true;
      this.logger.log("Ticket SLA-breach sweeper started");
    } catch (err) {
      this.logger.error("Failed to start ticket SLA-breach sweeper", err);
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
    // Its OWN try, like every sibling — a shared try skipped the later starts
    // entirely and left an earlier one running with its stop-flag false.
    try {
      // Links any contact with no Customer yet (unified identity, §6) — 60s
      // reconciler covering every non-inline create path.
      startCustomerLinkSweeper();
      this.customerLinkSweeperStarted = true;
      this.logger.log("Customer link sweeper started");
    } catch (err) {
      this.logger.error("Failed to start customer-link sweeper", err);
    }
    try {
      // Moves conversations off agents who went offline, for teams that opted
      // in (AssignmentSettings.reassignOnOffline). No-ops entirely when this
      // process can't see socket presence.
      startAssignmentRebalanceSweeper();
      this.assignmentRebalanceSweeperStarted = true;
      this.logger.log("Assignment rebalance sweeper started");
    } catch (err) {
      this.logger.error("Failed to start assignment-rebalance sweeper", err);
    }
    try {
      // Daily reconciler for the Conversation analytics MESSAGE COUNTERS
      // (incoming/outgoing), which the fire-and-forget analytics helpers can
      // drift on a swallowed error. Same set-based-UPDATE shape as the contact
      // drift sweep.
      startConversationAnalyticsDriftSweeper();
      this.analyticsDriftSweeperStarted = true;
      this.logger.log("Conversation analytics drift sweeper started");
    } catch (err) {
      this.logger.error("Failed to start analytics-drift sweeper", err);
    }
    try {
      // Daily reconciler for `Conversation.openFlagCount`. The counter is
      // maintained transactionally with every flag write, so this only catches
      // the paths that bypass that code — chiefly a Message/Conversation
      // hard-delete cascading MessageFlag rows away without decrementing the
      // parent. Stale here would leave the "Flagged" inbox preset lying in
      // either direction.
      startMessageFlagCountDriftSweeper();
      this.messageFlagCountDriftSweeperStarted = true;
      this.logger.log("Message-flag count drift sweeper started");
    } catch (err) {
      this.logger.error("Failed to start message-flag-count-drift sweeper", err);
    }
    try {
      // Same shape, for `Conversation.openTicketCount` — which CLAUDE.md §7
      // also lists as sweeper-backed and, until now, wasn't. Catches a Ticket
      // cascade (Conversation/Contact delete) that takes rows without
      // decrementing the parent's counter.
      startOpenTicketCountDriftSweeper();
      this.openTicketCountDriftSweeperStarted = true;
      this.logger.log("Open-ticket count drift sweeper started");
    } catch (err) {
      this.logger.error("Failed to start open-ticket-count-drift sweeper", err);
    }
    try {
      // `Ticket.lastActivityAt` — the board's sort key. Maintained inline by
      // every writer, but `touchTicketActivity` swallows its own failure on
      // purpose (an ordering hint must not fail the write it decorates), so a
      // reconciler is what makes the column trustworthy (§7).
      startTicketLastActivityDriftSweeper();
      this.ticketLastActivityDriftSweeperStarted = true;
      this.logger.log("Ticket last-activity drift sweeper started");
    } catch (err) {
      this.logger.error("Failed to start ticket-last-activity-drift sweeper", err);
    }
    try {
      // Backstop for the campaign delivery denormalization: the live
      // propagation in ingest is fire-and-forget (a reporting write must never
      // cost a delivery receipt), so it can drop under pool pressure. This
      // re-derives deliveryState from Message for recently-finished campaigns.
      startBroadcastDeliveryDriftSweeper();
      this.broadcastDeliveryDriftSweeperStarted = true;
      this.logger.log("Broadcast delivery-drift sweeper started");
    } catch (err) {
      this.logger.error("Failed to start broadcast-delivery-drift sweeper", err);
    }
    try {
      // Daily delete of EXPIRED Better Auth Session + Verification rows
      // (Better Auth invalidates-on-read but never prunes). Active sessions
      // are untouched.
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
    try {
      // Daily retention on ConversationEvent (audit timeline) — the one
      // high-churn table that previously had no sweep. 90-day cutoff (tunable
      // via CONVERSATION_EVENT_RETENTION_DAYS). N2 in
      // tests/VERIFICATION-2026-07-29.md.
      startConversationEventRetentionSweeper();
      this.conversationEventRetentionStarted = true;
      this.logger.log("Conversation event retention sweeper started");
    } catch (err) {
      this.logger.error("Failed to start conversation-event retention sweeper", err);
    }
    // Its OWN try + flag, like every sibling.
    try {
      // Daily retention on per-user Notification rows.
      startNotificationRetentionSweeper();
      this.notificationRetentionStarted = true;
      this.logger.log("Notification retention sweeper started");
    } catch (err) {
      this.logger.error("Failed to start notification retention sweeper", err);
    }

    try {
      // Daily retention on ANONYMOUS website-widget visitors — the only channel
      // whose rows grow without bound (a cleared browser is a new contact). 90-day
      // cutoff (WEBCHAT_VISITOR_RETENTION_DAYS). Never touches identified visitors.
      startWebchatVisitorRetentionSweeper();
      this.webchatVisitorRetentionStarted = true;
      this.logger.log("Webchat visitor retention sweeper started");
    } catch (err) {
      this.logger.error("Failed to start webchat-visitor retention sweeper", err);
    }
    try {
      // Daily retention + orphan reclaim for the native AI subsystem. Its
      // conversationId/messageId columns carry no FK by design, so nothing else
      // reclaims a row whose thread is gone, and the voice-draft blobs are
      // prefix-excluded from blob-orphan. 90-day window (AI_RETENTION_DAYS).
      startAiRetentionSweeper();
      this.aiRetentionSweeperStarted = true;
      this.logger.log("AI retention sweeper started");
    } catch (err) {
      this.logger.error("Failed to start ai-retention sweeper", err);
    }
    try {
      // 5-minute online-time sampler behind the team report's "Online" column
      // (AgentPresenceDaily). Reads the in-memory presence registry, so it
      // only produces rows in the api process that owns the sockets.
      // AGENT_PRESENCE_SAMPLE=0 disables.
      startAgentPresenceSampler();
      this.agentPresenceSamplerStarted = true;
      this.logger.log("Agent presence sampler started");
    } catch (err) {
      this.logger.error("Failed to start agent-presence sampler", err);
    }
    try {
      // OPT-IN rawPayload bloat control (DB-1). No-ops unless
      // MESSAGE_RAWPAYLOAD_RETENTION_DAYS is set, so the default keeps payloads
      // forever (CLAUDE.md rule #4). Logs only when enabled + something is nulled.
      startMessageRawPayloadRetentionSweeper();
      this.messageRawPayloadRetentionStarted = true;
    } catch (err) {
      this.logger.error("Failed to start message-rawPayload retention sweeper", err);
    }
    try {
      // Fires SCHEDULED broadcasts at their scheduledAt (delayed BullMQ job →
      // CAS scheduled→queued → startBroadcast). Shares the inline-worker gate.
      startBroadcastScheduleWorker();
      this.broadcastScheduleWorkerStarted = true;
      this.logger.log("Broadcast schedule worker started");
    } catch (err) {
      this.logger.error("Failed to start broadcast-schedule worker", err);
    }
    try {
      // Runtime backstop for scheduled/queued broadcasts that strand between
      // deploys (fire-job retry exhaustion, partial scheduled-fire, Redis job
      // loss). Without it the only recovery is the next process restart — days,
      // for a pilot. Re-enqueues/re-fires idempotently every 60s.
      startBroadcastScheduleDriftSweeper();
      this.broadcastScheduleDriftSweeperStarted = true;
      this.logger.log("Broadcast schedule-drift sweeper started");
    } catch (err) {
      this.logger.error("Failed to start broadcast-schedule-drift sweeper", err);
    }
    try {
      // Materializes large broadcast audiences off the create HTTP path
      // (resolve audience + chunk-insert BroadcastRecipient rows → flip
      // materializing→queued → startBroadcast). Shares the inline-worker gate.
      startBroadcastMaterializeWorker();
      this.broadcastMaterializeWorkerStarted = true;
      this.logger.log("Broadcast materialize worker started");
    } catch (err) {
      this.logger.error("Failed to start broadcast-materialize worker", err);
    }
    try {
      // Backstop for `materializing` broadcasts whose materialize job stranded
      // (Redis job loss, worker crash mid-batch). Re-enqueues idempotently.
      startBroadcastMaterializeDriftSweeper();
      this.broadcastMaterializeDriftSweeperStarted = true;
      this.logger.log("Broadcast materialize-drift sweeper started");
    } catch (err) {
      this.logger.error("Failed to start broadcast-materialize-drift sweeper", err);
    }
    try {
      // Periodically re-syncs each team's WhatsApp messaging-limit tier / quality
      // / throughput from Graph so large broadcasts are gated on fresh capacity.
      startWhatsappHealthRefreshSweeper();
      this.whatsappHealthRefreshSweeperStarted = true;
      this.logger.log("WhatsApp health-refresh sweeper started");
    } catch (err) {
      this.logger.error("Failed to start whatsapp-health-refresh sweeper", err);
    }
    // Its OWN try, like every sibling — see the note below on why a shared try
    // leaves the other sweeper's stop-flag unset.
    try {
      // Inbound-webhook gap detection: verifies every Meta connection's
      // WABA/Page subscription + token against Graph, self-heals a dropped
      // subscription, and flags the Settings reconnect banner for what it
      // can't fix. Closes the one hole where inbound silently stops with
      // valid-looking credentials.
      startWebhookSubscriptionHealthSweeper();
      this.webhookSubscriptionHealthSweeperStarted = true;
      this.logger.log("Webhook subscription-health sweeper started");
    } catch (err) {
      this.logger.error("Failed to start webhook-subscription-health sweeper", err);
    }
    // Its OWN try, like every sibling.
    try {
      // Settles webhook-subscription releases owed to Meta — a removed
      // account whose DELETE /subscribed_apps failed keeps a durable IOU
      // (PendingSubscriptionRelease) that this retries with backoff.
      startSubscriptionReleaseRetrySweeper();
      this.subscriptionReleaseRetrySweeperStarted = true;
      this.logger.log("Subscription release-retry sweeper started");
    } catch (err) {
      this.logger.error("Failed to start subscription-release-retry sweeper", err);
    }
    // Its OWN try, like every sibling — see the note below on why a shared try
    // leaves the other sweeper's stop-flag unset.
    try {
      // Backstop for template CREATE/DELETE done in WhatsApp Manager, which no
      // webhook covers. Without it a catalog is only as fresh as the last time a
      // human pressed "Sync".
      startTemplateCatalogRefreshSweeper();
      this.templateCatalogRefreshStarted = true;
      this.logger.log("Template catalog-refresh sweeper started");
    } catch (err) {
      this.logger.error("Failed to start template-catalog-refresh sweeper", err);
    }
    // Its OWN try, like every sibling. Sharing one with the health sweeper
    // above meant a throw in either left the OTHER's stop-flag unset — so it
    // would be running but never stopped on shutdown, and the graceful-drain
    // guarantee would be quietly untrue for it.
    try {
      // Captures Meta's read/click figures before their ~7-day window closes.
      // Unlike every other sweeper here, missing a tick loses data PERMANENTLY.
      startTemplateAnalyticsCaptureSweeper();
      this.templateAnalyticsCaptureStarted = true;
      this.logger.log("Template-analytics capture sweeper started");
    } catch (err) {
      this.logger.error("Failed to start template-analytics-capture sweeper", err);
    }
    try {
      // Moves members across their working-hours boundaries (and expires manual
      // overrides at shift end). The ONLY thing that notices a schedule flip —
      // an agent who went home isn't around to trigger a recompute.
      startWorkHoursSweeper();
      this.workHoursSweeperStarted = true;
      this.logger.log("Working-hours availability sweeper started");
    } catch (err) {
      this.logger.error("Failed to start work-hours sweeper", err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.broadcastScheduleDriftSweeperStarted)
        stopBroadcastScheduleDriftSweeper();
    } catch (err) {
      this.logger.warn(
        `stopBroadcastScheduleDriftSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.broadcastMaterializeDriftSweeperStarted)
        stopBroadcastMaterializeDriftSweeper();
    } catch (err) {
      this.logger.warn(
        `stopBroadcastMaterializeDriftSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.workHoursSweeperStarted) stopWorkHoursSweeper();
    } catch (err) {
      this.logger.warn(
        `stopWorkHoursSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.whatsappHealthRefreshSweeperStarted)
        stopWhatsappHealthRefreshSweeper();
    } catch (err) {
      this.logger.warn(
        `stopWhatsappHealthRefreshSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.webhookSubscriptionHealthSweeperStarted)
        stopWebhookSubscriptionHealthSweeper();
    } catch (err) {
      this.logger.warn(
        `stopWebhookSubscriptionHealthSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.subscriptionReleaseRetrySweeperStarted)
        stopSubscriptionReleaseRetrySweeper();
    } catch (err) {
      this.logger.warn(
        `stopSubscriptionReleaseRetrySweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.templateCatalogRefreshStarted) stopTemplateCatalogRefreshSweeper();
    } catch (err) {
      this.logger.warn(
        `stopTemplateCatalogRefreshSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.templateAnalyticsCaptureStarted)
        stopTemplateAnalyticsCaptureSweeper();
    } catch (err) {
      this.logger.warn(
        `stopTemplateAnalyticsCaptureSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.conversationEventRetentionStarted) {
        stopConversationEventRetentionSweeper();
      }
      if (this.notificationRetentionStarted) stopNotificationRetentionSweeper();
      if (this.agentPresenceSamplerStarted) stopAgentPresenceSampler();
      if (this.webchatVisitorRetentionStarted) stopWebchatVisitorRetentionSweeper();
      if (this.messageRawPayloadRetentionStarted)
        stopMessageRawPayloadRetentionSweeper();
    } catch (err) {
      this.logger.warn(
        `stopConversationEventRetentionSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.aiRetentionSweeperStarted) stopAiRetentionSweeper();
    } catch (err) {
      this.logger.warn(
        `stopAiRetentionSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
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
      if (this.messageFlagCountDriftSweeperStarted) stopMessageFlagCountDriftSweeper();
    } catch (err) {
      this.logger.warn(
        `stopMessageFlagCountDriftSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.abandonedRegistrationSweeperStarted) stopAbandonedRegistrationSweeper();
    } catch (err) {
      this.logger.warn(
        `stopAbandonedRegistrationSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.openTicketCountDriftSweeperStarted) stopOpenTicketCountDriftSweeper();
    } catch (err) {
      this.logger.warn(
        `stopOpenTicketCountDriftSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.ticketLastActivityDriftSweeperStarted) stopTicketLastActivityDriftSweeper();
    } catch (err) {
      this.logger.warn(
        `stopTicketLastActivityDriftSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.contactDriftSweeperStarted) stopContactDriftSweeper();
    } catch (err) {
      this.logger.warn(`stopContactDriftSweeper threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.customerLinkSweeperStarted) stopCustomerLinkSweeper();
    } catch (err) {
      this.logger.warn(`stopCustomerLinkSweeper threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.assignmentRebalanceSweeperStarted) stopAssignmentRebalanceSweeper();
    } catch (err) {
      this.logger.warn(
        `stopAssignmentRebalanceSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.analyticsDriftSweeperStarted) stopConversationAnalyticsDriftSweeper();
    } catch (err) {
      this.logger.warn(
        `stopConversationAnalyticsDriftSweeper threw: ${err instanceof Error ? err.message : err}`,
      );
    }
    try {
      if (this.broadcastDeliveryDriftSweeperStarted) stopBroadcastDeliveryDriftSweeper();
    } catch (err) {
      this.logger.warn(
        `stopBroadcastDeliveryDriftSweeper threw: ${err instanceof Error ? err.message : err}`,
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
      if (this.staleCallsSweeperStarted) stopStaleCallsSweeper();
    } catch (err) {
      this.logger.warn(`stopStaleCallsSweeper threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.ticketSlaSweeperStarted) stopTicketSlaBreachSweeper();
    } catch (err) {
      this.logger.warn(`stopTicketSlaBreachSweeper threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.mediaSweeperStarted) stopInboundMediaSweeper();
    } catch (err) {
      this.logger.warn(`stopInboundMediaSweeper threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.callRecordingSweeperStarted) stopCallRecordingSweeper();
    } catch (err) {
      this.logger.warn(`stopCallRecordingSweeper threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.started) await stopWorkflowWorker();
    } catch (err) {
      this.logger.warn(`stopWorkflowWorker threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.broadcastScheduleWorkerStarted) await stopBroadcastScheduleWorker();
    } catch (err) {
      this.logger.warn(`stopBroadcastScheduleWorker threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      if (this.broadcastMaterializeWorkerStarted) await stopBroadcastMaterializeWorker();
    } catch (err) {
      this.logger.warn(`stopBroadcastMaterializeWorker threw: ${err instanceof Error ? err.message : err}`);
    }
    // ALWAYS close the queues — both this process's worker AND any HTTP path
    // (create/cancel) opens them via get*Queue.
    try {
      await closeWorkflowQueue();
    } catch (err) {
      this.logger.warn(`closeWorkflowQueue threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      await closeBroadcastScheduleQueue();
    } catch (err) {
      this.logger.warn(`closeBroadcastScheduleQueue threw: ${err instanceof Error ? err.message : err}`);
    }
    try {
      await closeBroadcastMaterializeQueue();
    } catch (err) {
      this.logger.warn(`closeBroadcastMaterializeQueue threw: ${err instanceof Error ? err.message : err}`);
    }
  }
}
