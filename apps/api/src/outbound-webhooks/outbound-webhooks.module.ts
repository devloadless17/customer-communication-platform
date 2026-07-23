import { Module } from "@nestjs/common";

import { OutboundWebhooksSubscriber } from "./outbound-webhooks.subscriber";
import { OutboundWebhooksWorkerService } from "./outbound-webhooks-worker.service";

/**
 * Wires the outbound-webhook pipeline:
 *
 *   bus event  ─►  OutboundWebhooksSubscriber
 *                  │
 *                  ▼ persists OutboundWebhookDelivery rows
 *                  │
 *                  ▼ enqueues webhook:deliver BullMQ jobs
 *                  │
 *   redis     ─►  OutboundWebhooksWorkerService
 *                  │
 *                  ▼ HTTP POST with HMAC, updates delivery row + breaker
 *
 * The CRUD HTTP surface lives in `apps/api/src/team/outbound-webhooks/`
 * (WorkspaceSettingsModule import). It's separate from this module by design — the
 * pipeline above must boot even if the admin UI is never used (e.g. a
 * partner created their webhook via API key + curl).
 */
@Module({
  providers: [OutboundWebhooksSubscriber, OutboundWebhooksWorkerService],
})
export class OutboundWebhooksModule {}
