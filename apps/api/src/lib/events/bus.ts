// Note: no `server-only` import — boots from both server.ts (web) and
// worker.ts (worker process), outside Next's bundler context. Same convention
// as lib/socket/server.ts and lib/workflows/queue.ts.

import type {
  DomainEvent,
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
 * Typed in-process event bus, optionally bridged across processes via Redis
 * pub/sub.
 *
 * Routes / ingest publish a `DomainEvent`; subscribers (socket fanout, audit
 * log, analytics, workflow dispatcher, outbound webhooks) react to it.
 *
 * Two subscriber modes:
 *   - `"local"` (default) — fires only when the event was published in THIS
 *                            process. Right for DB writes (audit, analytics,
 *                            workflow dispatch) — those side effects belong
 *                            to the origin process and would double-execute
 *                            if run on a forwarded event.
 *   - `"any"`             — fires on both local AND forwarded events. Right
 *                            for socket fanout, which can only emit from the
 *                            process that owns the IO singleton (the web
 *                            server). A worker-side publish of e.g.
 *                            `contact.updated` forwards over Redis; the web's
 *                            `any`-mode socket-fanout receives it and emits
 *                            to connected clients.
 *
 * Subscribers run in PARALLEL (Promise.allSettled). Each handler is
 * functionally independent — own table writes, own socket emit, own HTTP
 * RTT — and sequencing them earlier was paying the sum of per-subscriber
 * latency on every publish. If two subscribers ever need to order against
 * each other, model that explicitly in their own state, not through bus
 * registration order.
 *
 * Bridge wiring lives in lib/events/redis-bridge.ts. Without a bridge
 * (default), publish() is purely in-process and `mode` has no behavioral
 * effect — every subscriber fires on every event regardless.
 */

type Mode = "local" | "any";
type Handler<K extends DomainEventType> = (
  event: DomainEventOf<K>,
) => void | Promise<void>;

interface SubscriberRecord {
  handler: Handler<DomainEventType>;
  mode: Mode;
}

interface BusState {
  handlers: Map<DomainEventType, SubscriberRecord[]>;
  /**
   * Redis pub/sub forwarder. Set by `enableRedisBridge()` when the cross-
   * process bridge is wired in. Left null for the single-process default
   * path — no overhead when not in use.
   */
  redisForwarder: ((event: DomainEvent) => void) | null;
}

const g = globalThis as unknown as { __ccpEventBus?: BusState };
const state: BusState = (g.__ccpEventBus ??= {
  handlers: new Map(),
  redisForwarder: null,
});

/**
 * Register a subscriber for a single event type.
 *
 * `options.mode` defaults to `"local"`. Use `"any"` for subscribers that
 * should react regardless of which process published the event (typically
 * socket fanout).
 *
 * Returns an unsubscribe function — handy for tests, not used in normal app
 * code.
 */
export function subscribe<K extends DomainEventType>(
  type: K,
  handler: Handler<K>,
  options: { mode?: Mode } = {},
): () => void {
  const record: SubscriberRecord = {
    handler: handler as Handler<DomainEventType>,
    mode: options.mode ?? "local",
  };
  const list = state.handlers.get(type) ?? [];
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
 * Publish a locally-originated domain event.
 *
 * Writes a row to the transactional outbox FIRST (durable audit trail),
 * then runs every subscriber (regardless of `mode`) in registration order.
 * Each subscriber gets its own try/catch so a broken one can't cascade.
 * After local fan-out, forwards to the cross-process bridge if one's
 * enabled. On the way out, marks the outbox row published (or failed).
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
    await runSubscribers(event, false);
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

  const forwarder = state.redisForwarder;
  if (forwarder) {
    try {
      forwarder(event as DomainEvent);
    } catch (err) {
      console.error(
        withCorrelation(`[bus] redis forward for "${event.type}" failed:`),
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Internal entry point used by the Redis bridge when an event arrives from
 * another process. Runs ONLY `mode: "any"` subscribers (skips `local`) AND
 * does NOT re-forward (which would create an infinite loop).
 *
 * Exported so lib/events/redis-bridge.ts can invoke it; callers outside
 * the bridge should always use `publish` instead.
 */
export async function publishForwarded<K extends DomainEventType>(
  event: DomainEventOf<K>,
): Promise<void> {
  await runSubscribers(event, true);
}

/**
 * Dispatch a row that was already written to the outbox via
 * `publishInTx`. Runs ALL subscribers (same as `publish`) but does NOT
 * write another outbox row — the row already exists; the drainer is
 * responsible for marking it `publishedAt`. Internal API; only the
 * OutboxDrainerService should call this.
 */
export async function dispatchPersistedEvent<K extends DomainEventType>(
  event: DomainEventOf<K>,
): Promise<void> {
  await runSubscribers(event, false);
}

async function runSubscribers<K extends DomainEventType>(
  event: DomainEventOf<K>,
  forwardedOnly: boolean,
): Promise<void> {
  const list = state.handlers.get(event.type as DomainEventType);
  if (!list || list.length === 0) return;

  // Run subscribers in parallel. They're functionally independent (each one
  // writes its own table or fires its own emit), so the prior sequential
  // `await` chain was paying the SUM of per-subscriber latencies on every
  // publish — e.g. on `message.received` that was socket-fanout + audit DB
  // write + analytics DB write + workflow-dispatch (DB lookup + per-trigger
  // enqueue) + web-cache-revalidate (HTTP RTT to Next.js). On a team with
  // workflows wired to inbound messages, the floor was hundreds of
  // milliseconds before publish() returned to the webhook handler. Going
  // parallel collapses that to the slowest single subscriber.
  //
  // Each handler still gets its own try/catch so a broken subscriber can't
  // poison the others; allSettled keeps that guarantee at the Promise layer
  // (we never throw from this function, matching the prior contract).
  await Promise.allSettled(
    list.map(async (sub, i) => {
      if (forwardedOnly && sub.mode === "local") return;
      try {
        await sub.handler(event as DomainEventOf<DomainEventType>);
      } catch (err) {
        console.error(
          withCorrelation(
            `[bus] subscriber #${i} for "${event.type}" threw${forwardedOnly ? " (forwarded)" : ""}:`,
          ),
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
}

/**
 * Install a cross-process forwarder. Called once per process by the Redis
 * bridge module. After this, every locally-published event is also handed
 * to the forwarder for cross-process delivery.
 *
 * Single-process MVP leaves this unset — the bus is purely in-process and
 * there's zero overhead.
 */
export function enableRedisBridge(forwarder: (event: DomainEvent) => void): void {
  state.redisForwarder = forwarder;
}

/**
 * Disable the bridge. Used by graceful shutdown so in-flight publishes
 * don't try to forward into a closing Redis connection.
 */
export function disableRedisBridge(): void {
  state.redisForwarder = null;
}

/**
 * Test/teardown helper: drop all subscribers + bridge. NOT used in app code.
 */
export function __resetBusForTests(): void {
  state.handlers.clear();
  state.redisForwarder = null;
}
