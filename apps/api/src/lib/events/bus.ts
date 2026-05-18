// Note: no `server-only` import — boots from both server.ts (web) and
// worker.ts (worker process), outside Next's bundler context. Same convention
// as lib/socket/server.ts and lib/workflows/queue.ts.

import type {
  DomainEventOf,
  DomainEventType,
} from "@ccp/shared/events/types";

import { withCorrelation } from "@/common/correlation";
import {
  markFailed as markOutboxFailed,
  markPublished as markOutboxPublished,
  persistOutboxRow,
} from "@/lib/events/outbox";

/**
 * Typed in-process event bus.
 *
 * Routes / ingest publish a `DomainEvent`; subscribers (socket fanout, audit
 * log, analytics, workflow dispatcher, outbound webhooks) react to it.
 *
 * Subscribers run in PARALLEL (Promise.allSettled). Each handler is
 * functionally independent — own table writes, own socket emit, own HTTP
 * RTT — and sequencing them earlier was paying the sum of per-subscriber
 * latency on every publish. If two subscribers ever need to order against
 * each other, model that explicitly in their own state, not through bus
 * registration order.
 */

type Handler<K extends DomainEventType> = (
  event: DomainEventOf<K>,
) => void | Promise<void>;

interface BusState {
  handlers: Map<DomainEventType, Handler<DomainEventType>[]>;
}

const g = globalThis as unknown as { __ccpEventBus?: BusState };
const state: BusState = (g.__ccpEventBus ??= {
  handlers: new Map(),
});

/**
 * Register a subscriber for a single event type. Returns an unsubscribe
 * function — handy for tests, not used in normal app code.
 */
export function subscribe<K extends DomainEventType>(
  type: K,
  handler: Handler<K>,
): () => void {
  const list = state.handlers.get(type) ?? [];
  const record = handler as Handler<DomainEventType>;
  list.push(record);
  state.handlers.set(type, list);
  return () => {
    const current = state.handlers.get(type);
    if (!current) return;
    const idx = current.indexOf(record);
    if (idx >= 0) current.splice(idx, 1);
  };
}

/**
 * Publish a domain event.
 *
 * Writes a row to the transactional outbox FIRST (durable audit trail),
 * then runs every subscriber in parallel. Each subscriber gets its own
 * try/catch so a broken one can't cascade. On the way out, marks the
 * outbox row published (or failed).
 *
 * Most callers should `await`. The webhook hot path uses `void publish(...)`
 * + `.catch(...)` to avoid blocking Meta's 200.
 *
 * For publishes that must commit atomically with an entity write, use
 * `publishInTx(tx, event)` from `@/lib/events/outbox` instead. That path
 * skips the synchronous subscriber run and lets the drainer dispatch
 * once the caller's transaction commits — closes the lost-event window
 * between the entity write and bus.publish.
 *
 * Outbox-write failures (Postgres down) are swallowed and logged — the
 * subscribers still run. The choice is: better to lose the audit row
 * than to lose the realtime emit. Operators see the gap via missing
 * outbox rows.
 */
export async function publish<K extends DomainEventType>(
  event: DomainEventOf<K>,
): Promise<void> {
  let outboxId: string | null = null;
  try {
    outboxId = await persistOutboxRow(event);
  } catch (err) {
    console.error(
      withCorrelation(`[bus] outbox persist for "${event.type}" failed:`),
      err instanceof Error ? err.message : err,
    );
    // Continue — better stale audit than dropped fanout.
  }

  let dispatchError: unknown = null;
  try {
    await runSubscribers(event);
  } catch (err) {
    dispatchError = err;
  }

  if (outboxId) {
    try {
      if (dispatchError) {
        await markOutboxFailed(
          outboxId,
          dispatchError instanceof Error ? dispatchError.message : String(dispatchError),
        );
      } else {
        await markOutboxPublished(outboxId);
      }
    } catch (err) {
      console.error(
        withCorrelation(`[bus] outbox status-mark for "${event.type}" failed:`),
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Dispatch a row that was already written to the outbox via
 * `publishInTx`. Runs subscribers but does NOT write another outbox row —
 * the row already exists; the drainer is responsible for marking it
 * `publishedAt`. Internal API; only the OutboxDrainerService should call.
 */
export async function dispatchPersistedEvent<K extends DomainEventType>(
  event: DomainEventOf<K>,
): Promise<void> {
  await runSubscribers(event);
}

async function runSubscribers<K extends DomainEventType>(
  event: DomainEventOf<K>,
): Promise<void> {
  const list = state.handlers.get(event.type as DomainEventType);
  if (!list || list.length === 0) return;

  // Run subscribers in parallel. They're functionally independent (each one
  // writes its own table or fires its own emit), so the prior sequential
  // `await` chain was paying the SUM of per-subscriber latencies on every
  // publish — e.g. on `message.received` that was socket-fanout + audit DB
  // write + analytics DB write + workflow-dispatch + web-cache-revalidate.
  // Going parallel collapses that to the slowest single subscriber.
  //
  // Each handler still gets its own try/catch so a broken subscriber can't
  // poison the others.
  await Promise.allSettled(
    list.map(async (handler, i) => {
      try {
        await handler(event as DomainEventOf<DomainEventType>);
      } catch (err) {
        console.error(
          withCorrelation(`[bus] subscriber #${i} for "${event.type}" threw:`),
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
}
