import { Global, Module } from "@nestjs/common";

import { RealtimeEmitter } from "./emitter.service";
import { PresenceService } from "./presence.service";
import { RealtimeFanoutService } from "./realtime-fanout.service";
import { RealtimeGateway } from "./realtime.gateway";
import { SocketAuthService } from "./socket-auth.service";
import { TypingService } from "./typing.service";

/**
 * Owns the Socket.io gateway, presence + typing state, the typed emitter,
 * the handshake auth helper, and the bus-subscribed fanout service.
 *
 * Global so feature modules (Phase 3+) can inject `RealtimeEmitter`
 * directly to push room-targeted emits when needed (e.g. forwarded webhook
 * outputs in /v1/external).
 */
@Global()
@Module({
  providers: [
    RealtimeGateway,
    RealtimeEmitter,
    PresenceService,
    TypingService,
    SocketAuthService,
    RealtimeFanoutService,
  ],
  exports: [RealtimeGateway, RealtimeEmitter],
})
export class RealtimeModule {}
