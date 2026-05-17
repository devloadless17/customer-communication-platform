import { Module } from "@nestjs/common";

import { MetaWebhookController } from "./meta/meta.controller";

/**
 * All inbound webhook endpoints. Meta is the only provider today; generic
 * per-provider routing (the `/api/webhooks/[provider]/[teamId]` route in
 * Next.js) is intentionally NOT ported yet — it's a thin shim that today
 * only routes to Meta anyway, and porting it without a second provider
 * would just be ceremony.
 */
@Module({
  controllers: [MetaWebhookController],
})
export class WebhooksModule {}
