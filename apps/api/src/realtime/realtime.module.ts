import { Global, Module } from "@nestjs/common";

import { RealtimeEmitter } from "./emitter.service";
import { PresenceService } from "./presence.service";
import { RealtimeFanoutService } from "./realtime-fanout.service";
import { RealtimeGateway } from "./realtime.gateway";
import { SocketAuthService } from "./socket-auth.service";
import { TypingService } from "./typing.service";

/**
 * SOCKET.IO realtime layer. Owns the gateway, presence + typing state,
 * the typed emitter, the handshake auth helper, and the bus-subscribed
 * fanout service.
 *
 * Boundary against the events module:
 *
 *   apps/api/src/events/   → in-process pub/sub bus (DomainEvent values).
 *                            Pure domain — nothing here is socket-aware.
 *   apps/api/src/realtime/ → THIS module. Socket.io gateway +
 *                            RealtimeEmitter + RealtimeFanoutService.
 *                            RealtimeFanoutService is the ONLY component
 *                            that should ever cross from the bus into a
 *                            socket emit.
 *
 * Rule of thumb: if you're tempted to `bus.subscribe(...)` from a
 * feature module to push something at clients, you actually want
 * RealtimeFanoutService to grow a new subscriber instead — keeps the
 * cross-cutting "events → sockets" translation in one place.
 *
 * Global so feature modules can inject `RealtimeEmitter` directly to
 * push room-targeted emits when needed (e.g. forwarded webhook outputs
 * in /v1/external).
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
  exports: [RealtimeGateway, RealtimeEmitter, RealtimeFanoutService],
})
export class RealtimeModule {}
