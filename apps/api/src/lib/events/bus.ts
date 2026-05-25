// Note: no `server-only` import — this is loaded by the NestJS api process
// via @swc-node/register, outside the Next bundler context. Same convention
// as lib/workflows/queue.ts.

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

/**
 * Subscriber execution tiers. LOWER runs first. The order is LOAD-BEARING,
 * not cosmetic:
 *   - `workflow-dispatch` re-reads conversation state that `analytics`
 *     writes (closedCategory / counters), so it must run AFTER analytics.
 *   - `outbound-webhooks` ships partner payloads carrying those same
 *     post-mutation fields (closedAt, firstResponseAt), so it must run
 *     AFTER analytics too.
 * Encoding the order as an explicit priority — rather than relying on
 * module import order / `OnModuleInit` registration timing — makes it
 * impossible for a reorder of `AppModule.imports` to silently break it.
 * REALTIME MUST stay 0: `runSubscribers` fires the first record
 * fire-and-forget so a slow downstream subscriber can't delay the socket
 * emit the inbox UI is waiting on.
 */
export const SubscriberPriority = {
  REALTIME: 0,
  AUDIT: 10,
  ANALYTICS: 20,
  WORKFLOW_DISPATCH: 30,
  WEB_CACHE_REVALIDATE: 40,
  OUTBOUND_WEBHOOKS: 50,
  DEFAULT: 100,
} as const;

interface SubscriberRecord {
  handler: Handler<DomainEventType>;
  priority: number;
}

interface BusState {
  handlers: Map<DomainEventType, SubscriberRecord[]>;
}

const g = globalThis as unknown as { __ccpEventBus?: BusState };
const state: BusState = (g.__ccpEventBus ??= {
  handlers: new Map(),
});

/**
 * Register a subscriber for a single event type. `priority` fixes the
 * execution tier (lower runs first; see `SubscriberPriority`) so order is
 * independent of registration timing. Returns an unsubscribe function —
 * handy for tests + `OnModuleDestroy`.
 */
export function subscribe<K extends DomainEventType>(
  type: K,
  handler: Handler<K>,
  priority: number = SubscriberPriority.DEFAULT,
): () => void {
  const list = state.handlers.get(type) ?? [];
  const record: SubscriberRecord = {
    handler: handler as Handler<DomainEventType>,
    priority,
  };
  // Insert keeping the list sorted by ascending priority, STABLE within a
  // tier (insert after all existing records of equal-or-lower priority).
  let idx = list.length;
  for (let i = 0; i < list.length; i++) {
    if (list[i]!.priority > priority) {
      idx = i;
      break;
    }
  }
  list.splice(idx, 0, record);
  state.handlers.set(type, list);
  return () => {
    const current = state.handlers.get(type);
    if (!current) return;
    const at = current.indexOf(record);
    if (at >= 0) current.splice(at, 1);
  };
}

/**
 * Publish a domain event.
 *
 * Runs subscribers SEQUENTIALLY in priority order (see `SubscriberPriority`
 * + `runSubscribers`), then writes a single durable audit row to the outbox
 * with the final state (`publishedAt` always set, plus `failedAt`+`lastError`
 * if any subscriber threw). The row is written AFTER dispatch — never before
 * — so the outbox drainer's 100ms poll cannot grab it mid-dispatch and
 * re-fire every subscriber.
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

  // The list is kept sorted by `SubscriberPriority` on insert, so `list[0]`
  // is the lowest tier. When that's the REALTIME tier (0), fire it
  // SYNCHRONOUSLY + fire-and-forget so a slow downstream subscriber
  // (workflow-dispatch, outbound-webhooks) can't add latency to the socket
  // emit the inbox UI is waiting on. The realtime subscriber is itself a
  // `void emit(...)` to Socket.io and never throws synchronously, so firing
  // it outside the awaited sequence is safe.
  //
  // CRITICAL: this only holds when `list[0]` actually IS the realtime tier.
  // Events with a `null` fanout rule (`contact.tag_changed` /
  // `contact.lifecycle_changed`) have NO realtime subscriber — their
  // lowest-tier handler is a real awaited subscriber (outbound-webhooks).
  // Firing THAT fire-and-forget would resolve `publish()` before the webhook
  // delivery rows are written and would hide its errors from the outbox row.
  // So when list[0] isn't REALTIME, fall through to the awaited loop at
  // index 0 and treat it like any other subscriber.
  let startIdx = 0;
  const first = list[0]!;
  if (first.priority === SubscriberPriority.REALTIME) {
    startIdx = 1;
    try {
      const maybe = first.handler(event as DomainEventOf<DomainEventType>);
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
  }

  // Remaining subscribers (or ALL of them when there's no realtime tier):
  // sequential dispatch in priority order. workflow-dispatch reads
  // post-mutation state that analytics writes; outbound-webhooks ships
  // partner payloads carrying those same fields. Parallel dispatch made both
  // races inevitable in proportion to subscriber latency. Each handler gets
  // its own try/catch so a broken subscriber can't poison the chain.
  for (let i = startIdx; i < list.length; i++) {
    const record = list[i]!;
    try {
      await record.handler(event as DomainEventOf<DomainEventType>);
    } catch (err) {
      console.error(
        withCorrelation(`[bus] subscriber #${i} for "${event.type}" threw:`),
        err instanceof Error ? err.message : err,
      );
    }
  }
}
