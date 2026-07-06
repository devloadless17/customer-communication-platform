import { Module } from "@nestjs/common";

import { CoexistenceWorkerService } from "../coexistence/coexistence-worker.service";
import { MetaWebhookController } from "./meta/meta.controller";

/**
 * All inbound webhook endpoints. Meta is the only provider today; generic
 * per-provider routing (the `/api/webhooks/[provider]/[teamId]` route in
 * Next.js) is intentionally NOT ported yet — it's a thin shim that today
 * only routes to Meta anyway, and porting it without a second provider
 * would just be ceremony.
 *
 * CoexistenceWorkerService runs the history-backfill BullMQ worker in-process
 * (the history webhook lands here and enqueues chunks it consumes).
 */
@Module({
  controllers: [MetaWebhookController],
  providers: [CoexistenceWorkerService],
})
export class WebhooksModule {}
