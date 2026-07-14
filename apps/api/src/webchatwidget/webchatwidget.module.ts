import { Module } from "@nestjs/common";

import { WebchatwidgetPublicController } from "./webchatwidget-public.controller";
import { WebchatwidgetDeliveryService } from "./webchatwidget-delivery.service";
import { WebchatwidgetGateway } from "./webchatwidget.gateway";

/**
 * The website chat-widget VISITOR surface: the public "/widget" Socket.io
 * gateway, its realtime-tier delivery subscriber, and the public HTTP endpoints
 * (config fetch + media upload/serve). All anonymous, site-key-authenticated —
 * kept in its own module, entirely separate from the agent realtime layer and
 * from the admin onboarding module (team/webchatwidget/).
 *
 * DbService + EventBus come from their @Global modules. This module deliberately
 * runs its OWN `bus.subscribe` (WebchatwidgetDeliveryService) rather than growing
 * RealtimeFanoutService, because the widget delivers on a DIFFERENT namespace to
 * ANONYMOUS visitors — not through the agent-authenticated RealtimeEmitter.
 */
@Module({
  controllers: [WebchatwidgetPublicController],
  providers: [WebchatwidgetGateway, WebchatwidgetDeliveryService],
})
export class WebchatwidgetModule {}
