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
 * Thin Nest wrapper around the existing typed event bus in
 * [lib/events/bus.ts](../../../../../lib/events/bus.ts).
 *
 * Why wrap at all? So feature modules inject `EventBus` and don't
 * import from `@/lib/events` directly. That gives us one seam to swap or
 * decorate (e.g. tracing, dedup, dead-letter) without touching every
 * publisher.
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
