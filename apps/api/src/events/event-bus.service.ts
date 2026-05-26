import { Injectable } from "@nestjs/common";

import {
  dispatchPersistedEvent as busDispatchPersistedEvent,
  publish as busPublish,
  subscribe as busSubscribe,
} from "@/lib/events/bus";
import type {
  DomainEventOf,
  DomainEventType,
} from "@ccp/shared/events/types";

/**
 * EventBus class lives in its own file (separate from `event-bus.module.ts`)
 * to break a circular import: the module file pulls in
 * `OutboxDrainerService`, which itself imports `EventBus`. When both files
 * sit in the same module, the drainer hits a TDZ on EventBus at module
 * initialization time.
 *
 * Importers should `from "@/events/event-bus.service"` for the class type,
 * not from `event-bus.module`. The module file re-exports `EventBus` for
 * backwards compatibility with existing call sites.
 */
@Injectable()
export class EventBus {
  /** Publish an event to all subscribers. */
  publish<K extends DomainEventType>(event: DomainEventOf<K>): Promise<void> {
    return busPublish(event);
  }

  /**
   * Register a subscriber. `priority` fixes the execution tier (lower runs
   * first; see `SubscriberPriority`). Returns an unsubscribe function —
   * useful in `OnModuleDestroy` hooks for clean shutdown.
   */
  subscribe<K extends DomainEventType>(
    type: K,
    handler: (event: DomainEventOf<K>) => void | Promise<void>,
    priority?: number,
  ): () => void {
    return busSubscribe(type, handler, priority);
  }

  /**
   * Internal hook used by OutboxDrainerService. Dispatches an event that
   * was already persisted to the outbox via `publishInTx` — the drainer
   * has already marked the row `publishedAt = NOW()`, so we skip the
   * outbox write inside `publish()` and run subscribers directly. Do NOT
   * call this from feature code; use `publish()` or `publishInTx()`.
   *
   * Returns an aggregated subscriber-error message (or null) so the drainer
   * can stamp `lastError` on the outbox row — otherwise a thrown subscriber
   * is only visible in stdout. See the `dispatchPersistedEvent` comment in
   * lib/events/bus.ts for the rationale.
   */
  dispatchOutboxRow<K extends DomainEventType>(
    event: DomainEventOf<K>,
  ): Promise<string | null> {
    return busDispatchPersistedEvent(event);
  }
}
