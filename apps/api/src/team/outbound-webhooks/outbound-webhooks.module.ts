import { Module } from "@nestjs/common";

import { OutboundWebhooksController } from "./outbound-webhooks.controller";
import { OutboundWebhooksService } from "./outbound-webhooks.service";

/**
 * CRUD HTTP surface for outbound webhooks. The bus subscriber +
 * BullMQ worker pipeline live in a separate module (`OutboundWebhooksModule`
 * at the api root) so the data-plane boots even when the admin UI is
 * never used.
 */
@Module({
  controllers: [OutboundWebhooksController],
  providers: [OutboundWebhooksService],
  exports: [OutboundWebhooksService],
})
export class OutboundWebhooksAdminModule {}
