import { Injectable } from "@nestjs/common";

import {
  dispatchPersistedEvent as busDispatchPersistedEvent,
  publish as busPublish,
  publishForwarded as busPublishForwarded,
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

  /**
   * Internal hook used by OutboxDrainerService. Dispatches an event that
   * was already persisted to the outbox via `publishInTx` — the drainer
   * has already marked the row `publishedAt = NOW()`, so we skip the
   * outbox write inside `publish()` and run subscribers directly. Do NOT
   * call this from feature code; use `publish()` or `publishInTx()`.
   */
  dispatchOutboxRow<K extends DomainEventType>(
    event: DomainEventOf<K>,
  ): Promise<void> {
    return busDispatchPersistedEvent(event);
  }
}
