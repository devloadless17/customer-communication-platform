import { Global, Injectable, Module } from "@nestjs/common";

import {
  publish as busPublish,
  publishForwarded as busPublishForwarded,
  subscribe as busSubscribe,
} from "@/lib/events/bus";
import type {
  DomainEventOf,
  DomainEventType,
} from "@ccp/shared/events/types";

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

type Mode = "local" | "any";

@Injectable()
export class EventBus {
  /** Publish a locally-originated event to all subscribers. */
  publish<K extends DomainEventType>(event: DomainEventOf<K>): Promise<void> {
    return busPublish(event);
  }

  /**
   * Publish an event that originated in another process (the cross-process
   * Redis bridge calls this). Skips `local`-mode subscribers AND does not
   * re-forward. Most code should never call this directly.
   */
  publishForwarded<K extends DomainEventType>(
    event: DomainEventOf<K>,
  ): Promise<void> {
    return busPublishForwarded(event);
  }

  /**
   * Register a subscriber. Returns an unsubscribe function — useful in
   * `OnModuleDestroy` hooks for clean shutdown.
   */
  subscribe<K extends DomainEventType>(
    type: K,
    handler: (event: DomainEventOf<K>) => void | Promise<void>,
    options: { mode?: Mode } = {},
  ): () => void {
    return busSubscribe(type, handler, options);
  }
}

@Global()
@Module({
  providers: [EventBus],
  exports: [EventBus],
})
export class EventBusModule {}
