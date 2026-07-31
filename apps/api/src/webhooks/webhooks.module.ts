import { Module } from "@nestjs/common";

import { CoexistenceWorkerService } from "../coexistence/coexistence-worker.service";
import { MetaWebhookController } from "./meta/meta.controller";
import { MetaWebhookIngestService } from "./meta/meta-webhook-ingest.service";
import { MetaDataDeletionController } from "./meta/data-deletion.controller";

/**
 * All inbound webhook endpoints. Meta is the only provider today; generic
 * per-provider routing (the `/api/webhooks/[provider]/[workspaceId]` route in
 * Next.js) is intentionally NOT ported yet — it's a thin shim that today
 * only routes to Meta anyway, and porting it without a second provider
 * would just be ceremony.
 *
 * CoexistenceWorkerService runs the history-backfill BullMQ worker in-process
 * (the history webhook lands here and enqueues chunks it consumes).
 */
@Module({
  controllers: [MetaWebhookController, MetaDataDeletionController],
  providers: [CoexistenceWorkerService, MetaWebhookIngestService],
})
export class WebhooksModule {}
