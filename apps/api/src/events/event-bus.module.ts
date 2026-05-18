import { Global, Module } from "@nestjs/common";

import { EventBus } from "./event-bus.service";
import { OutboxDrainerService } from "./outbox-drainer.service";

// Re-export so existing call sites that import `EventBus` from
// "@/events/event-bus.module" keep working. The class itself lives in
// event-bus.service.ts to break a circular import: OutboxDrainerService
// imports EventBus, this module file imports OutboxDrainerService, and
// before the split the import order hit a TDZ on the EventBus class.
export { EventBus };

/**
 * In-process DOMAIN event bus. This is the seam every service publishes
 * to when something happens that other parts of the system care about
 * (`message.received`, `conversation.assigned`, `team.catalog_changed`,
 * etc.). Subscribers include analytics, audit, workflow-dispatch, and
 * the realtime fanout — registered from their own modules and triggered
 * by publishes here.
 *
 * Boundary against the realtime module:
 *
 *   apps/api/src/events/   → THIS file. The pub/sub bus carrying
 *                            DomainEventType values across in-process
 *                            subscribers. NEVER touches Socket.io.
 *   apps/api/src/realtime/ → The Socket.io gateway + RealtimeEmitter.
 *                            One of its services (RealtimeFanoutService)
 *                            subscribes to events here and translates
 *                            DomainEvents → room-scoped socket emits.
 *
 * Rule of thumb: if you're tempted to `socket.emit(...)` somewhere that
 * isn't the realtime module, you almost certainly want to `bus.publish`
 * here instead — the fanout will pick it up.
 *
 * The wrap exists so feature modules inject `EventBus` rather than
 * importing from `@/lib/events` directly — one seam to swap or decorate
 * (tracing, dedup, dead-letter) without touching every publisher.
 *
 * The underlying bus is process-global (lives on `globalThis`), which is
 * fine: the NestJS process is a single Node process with a single bus
 * instance. Subscribers registered from one Nest module are visible to
 * publishers from another.
 */

@Global()
@Module({
  providers: [EventBus, OutboxDrainerService],
  exports: [EventBus],
})
export class EventBusModule {}
