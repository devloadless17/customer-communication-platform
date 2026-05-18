// Note: no `server-only` import — boots from both server.ts (web) and
// worker.ts (worker process), outside Next's bundler context. Same convention
// as lib/socket/server.ts and lib/workflows/queue.ts.

import type {
  DomainEvent,
  DomainEventOf,
  DomainEventType,
} from "@ccp/shared/events/types";

import { withCorrelation } from "@/common/correlation";

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
 * Order matters within each mode: registration order is fire order. See
 * lib/events/subscribers/index.ts for the canonical order rationale.
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
 * Runs every subscriber (regardless of `mode`) in registration order. Each
 * subscriber gets its own try/catch so a broken one can't cascade. After
 * local fan-out, forwards to the cross-process bridge if one's enabled.
 *
 * Most callers should `await`. The webhook hot path uses `void publish(...)`
 * + `.catch(...)` to avoid blocking Meta's 200.
 */
export async function publish<K extends DomainEventType>(
  event: DomainEventOf<K>,
): Promise<void> {
  await runSubscribers(event, false);

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

async function runSubscribers<K extends DomainEventType>(
  event: DomainEventOf<K>,
  forwardedOnly: boolean,
): Promise<void> {
  const list = state.handlers.get(event.type as DomainEventType);
  if (!list || list.length === 0) return;
  for (let i = 0; i < list.length; i++) {
    const sub = list[i]!;
    if (forwardedOnly && sub.mode === "local") continue;
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
  }
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
