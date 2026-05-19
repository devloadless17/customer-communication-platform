// Note: no `server-only` import — boots from both server.ts (web) and
// worker.ts (worker process), outside Next's bundler context. Same convention
// as lib/socket/server.ts and lib/workflows/queue.ts.

import type {
  DomainEventOf,
  DomainEventType,
} from "@ccp/shared/events/types";

import { withCorrelation } from "@/common/correlation";
import { persistDispatchedRow } from "@/lib/events/outbox";

/**
 * Typed in-process event bus.
 *
 * Routes / ingest publish a `DomainEvent`; subscribers (socket fanout, audit
 * log, analytics, workflow dispatcher, outbound webhooks) react to it.
 *
 * Subscribers run SEQUENTIALLY in registration order. Two downstream
 * subscribers depend on this order:
 *   - `workflow-dispatch` re-reads the conversation row for the
 *     `closedCategory`/`closedSummary`/counters that `analytics` just
 *     bumped (workflow-dispatch.ts:62,78). Parallel dispatch made that
 *     read racy in proportion to analytics' write latency.
 *   - `outbound-webhooks.subscriber` ships partner payloads carrying
 *     post-mutation fields (closedAt, firstResponseAt) — same fields the
 *     analytics subscriber sets.
 * Registration order is:
 *     realtime-fanout → audit → analytics → workflow-dispatch →
 *     web-cache-revalidate → outbound-webhooks
 * (see WorkflowSubscribersService + OutboundWebhooksSubscriber).
 *
 * Cost vs the old `Promise.allSettled` parallel shape: total publish
 * latency = sum of per-subscriber latency instead of max. At pilot scale
 * each subscriber is ~5-15ms (analytics + audit write + dispatch enqueue;
 * web-cache-revalidate is now fire-and-forget inside its own subscriber
 * to avoid the cross-process HTTP hop dominating the sum). The earlier
 * "parallel + ordering doesn't matter" claim was contradicted by the
 * downstream subscribers' own doc comments and by the symptoms that
 * showed up at audit time.
 *
 * Per-subscriber try/catch still isolates failures — a broken handler
 * cannot poison the chain.
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
 * Runs every subscriber in parallel, then writes a single durable audit
 * row to the outbox with the final state (`publishedAt` always set, plus
 * `failedAt`+`lastError` if any subscriber threw). The row is written
 * AFTER dispatch — never before — so the outbox drainer's 100ms poll
 * cannot grab it mid-dispatch and re-fire every subscriber.
 *
 * Each subscriber gets its own try/catch inside `runSubscribers` so a
 * broken one can't cascade.
 *
 * Most callers should `await`. The webhook hot path uses `void publish(...)`
 * + `.catch(...)` to avoid blocking Meta's 200.
 *
 * For publishes that must commit atomically with an entity write, use
 * `publishInTx(tx, event)` from `@/lib/events/outbox` instead. That path
 * persists a row with `publishedAt=NULL` inside the tx; the drainer picks
 * it up after commit and dispatches subscribers. Closes the lost-event
 * window between the entity write and bus.publish.
 *
 * Outbox-write failures (Postgres down) are swallowed and logged — the
 * subscribers already ran. The choice is: better to lose the audit row
 * than to lose the realtime emit. Process crash mid-dispatch loses both
 * the audit row AND completes partially, but that's the same posture the
 * surrounding code carries.
 */
export async function publish<K extends DomainEventType>(
  event: DomainEventOf<K>,
): Promise<void> {
  let dispatchError: unknown = null;
  try {
    await runSubscribers(event);
  } catch (err) {
    dispatchError = err;
  }

  const errorMessage = dispatchError
    ? dispatchError instanceof Error
      ? dispatchError.message
      : String(dispatchError)
    : null;

  try {
    await persistDispatchedRow(event, errorMessage);
  } catch (err) {
    console.error(
      withCorrelation(`[bus] outbox persist for "${event.type}" failed:`),
      err instanceof Error ? err.message : err,
    );
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

  // Realtime fanout fires SYNCHRONOUSLY before the awaited chain — so a
  // slow downstream subscriber (workflow-dispatch, outbound-webhooks)
  // cannot add latency to the socket emit that the inbox UI is waiting
  // on. The realtime subscriber is itself a `void emit(...)` to Socket.io
  // and never throws synchronously, so this is safe to fire-and-forget
  // outside the try/catch sequence. Subsequent subscribers still need
  // the ordering invariant (workflow-dispatch reads analytics' writes).
  //
  // Identified by registration name convention: the realtime subscriber
  // is always registered first AND its handler is fast. We don't have
  // a tag system yet, so we treat handler #0 as the realtime tier.
  // RealtimeFanoutService MUST be the first subscribe(...) for each
  // event type — verified by the registration site in
  // realtime-fanout.service.ts (subscribers register at module init).
  const first = list[0]!;
  try {
    const maybe = first(event as DomainEventOf<DomainEventType>);
    if (maybe && typeof (maybe as Promise<void>).then === "function") {
      void (maybe as Promise<void>).catch((err) => {
        console.error(
          withCorrelation(`[bus] subscriber #0 (realtime) for "${event.type}" threw:`),
          err instanceof Error ? err.message : err,
        );
      });
    }
  } catch (err) {
    console.error(
      withCorrelation(`[bus] subscriber #0 (realtime) for "${event.type}" threw:`),
      err instanceof Error ? err.message : err,
    );
  }

  // Remaining subscribers: sequential dispatch in registration order.
  // workflow-dispatch reads post-mutation state that analytics writes;
  // outbound-webhooks ships partner payloads carrying those same fields.
  // Parallel dispatch made both races inevitable in proportion to
  // subscriber latency. Each handler gets its own try/catch so a broken
  // subscriber can't poison the chain.
  for (let i = 1; i < list.length; i++) {
    const handler = list[i]!;
    try {
      await handler(event as DomainEventOf<DomainEventType>);
    } catch (err) {
      console.error(
        withCorrelation(`[bus] subscriber #${i} for "${event.type}" threw:`),
        err instanceof Error ? err.message : err,
      );
    }
  }
}
