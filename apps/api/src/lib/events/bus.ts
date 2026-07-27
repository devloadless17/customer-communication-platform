// Note: no `server-only` import — this is loaded by the NestJS api process
// via @swc-node/register, outside the Next bundler context. Same convention
// as lib/workflows/queue.ts.

import type {
  DomainEventOf,
  DomainEventType,
} from "@ccp/shared/events/types";

import { withCorrelation } from "@/common/correlation";
import { markDispatched, persistDispatchedRow } from "@/lib/events/outbox";

/**
 * Typed in-process event bus.
 *
 * Routes / ingest publish a `DomainEvent`; subscribers (socket fanout, audit
 * log, analytics, workflow dispatcher, outbound webhooks) react to it.
 *
 * Two-tier dispatch (see `runCriticalTier` + `runBackgroundTier`):
 *
 *   CRITICAL (REALTIME, priority 0)
 *     Fired fire-and-forget at the head — the socket frame is on the wire
 *     before any downstream subscriber starts. `publish()` awaits the
 *     realtime promise just-in-time before persisting the outbox row so
 *     a realtime throw still lands in `lastError`.
 *
 *   BACKGROUND (AUDIT, ANALYTICS, WORKFLOW_DISPATCH,
 *               OUTBOUND_WEBHOOKS, DEFAULT)
 *     Run SEQUENTIALLY in priority order, DETACHED from `publish()` —
 *     the HTTP handler that called `await publish(...)` returns as soon
 *     as the outbox row write resolves; analytics + workflow dispatch +
 *     partner webhook fanout no longer add latency to the response.
 *     Sequential ordering inside this tier is load-bearing:
 *       - `workflow-dispatch` re-reads conversation state (closedCategory /
 *         counters) that `analytics` writes (workflow-dispatch.ts:62,78).
 *       - `outbound-webhooks.subscriber` ships partner payloads carrying
 *         those same post-mutation fields.
 *     Registration order:
 *       realtime-fanout → audit → analytics → workflow-dispatch →
 *       outbound-webhooks
 *     Encoded as explicit priorities, not registration timing, so a
 *     reorder of `AppModule.imports` can't silently break it.
 *
 * Per-subscriber try/catch still isolates failures — a broken handler
 * cannot poison the chain.
 *
 * The drainer's path (`dispatchPersistedEvent`) AWAITS ALL TIERS via
 * `runAllSubscribersAwaited` so it can stamp `lastError` accurately.
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
 * REALTIME MUST stay 0: `runCriticalTier` fires the first record
 * fire-and-forget so a slow downstream subscriber can't delay the socket
 * emit the inbox UI is waiting on.
 */
export const SubscriberPriority = {
  REALTIME: 0,
  /**
   * A SECOND realtime-latency consumer for the same event (today: the webchat
   * widget's visitor-side delivery, which must land as fast as the agent-side
   * fanout but is a different audience). Deliberately 1, not 0: only `list[0]`
   * runs in the critical tier, so two priority-0 registrations decided the
   * winner by `AppModule.imports` order — the exact fragility these tiers
   * exist to remove. `assertSingleCriticalSubscriber` pins it at boot.
   */
  REALTIME_SECONDARY: 1,
  AUDIT: 10,
  ANALYTICS: 20,
  WORKFLOW_DISPATCH: 30,
  // (40 was WEB_CACHE_REVALIDATE — removed 2026-06-01: no subscriber ever
  //  registered there. Cross-process cache revalidation goes through the
  //  HTTP /api/internal/revalidate bridge, not a prioritized bus tier.)
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
/**
 * How many REALTIME-tier subscribers are registered for `type`.
 *
 * Only `list[0]` is dispatched as the critical tier (see `runCriticalTier`),
 * so a SECOND priority-0 registration silently lands in the detached
 * background chain — and which one wins is decided by `AppModule.imports`
 * order, the exact fragility the priority tiers exist to remove. The
 * bootstrap assertion (`assertSingleCriticalSubscriber`) turns that into a
 * loud boot failure instead of a race nobody can see.
 */
export function criticalSubscriberCount(type: DomainEventType): number {
  const list = state.handlers.get(type) ?? [];
  return list.filter((r) => r.priority === SubscriberPriority.REALTIME).length;
}

/**
 * Boot-time invariant: at most ONE realtime-tier subscriber per event type.
 * Called from the drainer's bootstrap (after every module has registered).
 * Throws with the offending event types so the failure names itself.
 */
export function assertSingleCriticalSubscriber(): void {
  const offenders: string[] = [];
  for (const [type, list] of state.handlers) {
    const n = list.filter((r) => r.priority === SubscriberPriority.REALTIME).length;
    if (n > 1) offenders.push(`${type} (${n})`);
  }
  if (offenders.length > 0) {
    throw new Error(
      `[bus] more than one REALTIME-tier subscriber for: ${offenders.join(", ")}. ` +
        "Only list[0] runs in the critical tier; the rest silently fall into the " +
        "background chain, ordered by module-init luck. Give the secondary one an " +
        "explicit tier (e.g. REALTIME + 1).",
    );
  }
}

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
 * Two-tier dispatch:
 *   - CRITICAL (REALTIME, priority 0) fires fire-and-forget at the head of
 *     `runSubscribers`. The socket frame goes out without waiting for any
 *     downstream subscriber.
 *   - BACKGROUND (AUDIT, ANALYTICS, WORKFLOW_DISPATCH,
 *     OUTBOUND_WEBHOOKS, DEFAULT) used to run in-line and forced the HTTP
 *     handler that called `await publish(...)` to wait for analytics writes,
 *     workflow dispatch enqueues, and partner webhook fanout before
 *     responding. Now they run DETACHED — `publish()` returns as soon as
 *     critical realtime has been spawned + the outbox row has been written.
 *
 * The outbox row is written with whatever realtime-tier error is known by
 * the time the row write begins (we briefly await the realtime promise
 * before persisting — by that point background hasn't been spawned yet so
 * there's no latency-on-the-critical-path cost beyond realtime's own time).
 * Background subscriber errors are NOT merged into the row (they run after
 * the row is committed). This matches the existing "better to lose the
 * audit row than to lose the realtime emit" posture — the outbox row from
 * the `publish()` path is best-effort audit; the durable trail for
 * background failures is each subscriber's own logging + the outbox row
 * written by `publishInTx` + the drainer for callers that need durability (at-least-once).
 *
 * The outbox drainer's path (`dispatchPersistedEvent`) keeps awaiting ALL
 * tiers so the drainer can stamp `lastError` accurately.
 *
 * Most callers should `await`. The webhook hot path uses `void publish(...)`
 * + `.catch(...)` to avoid blocking Meta's 200.
 *
 * For publishes that must commit atomically with an entity write, use
 * `publishInTx(tx, event)` from `@/lib/events/outbox` instead.
 *
 * Outbox-write failures (Postgres down) are swallowed and logged — the
 * subscribers already ran.
 */
export async function publish<K extends DomainEventType>(
  event: DomainEventOf<K>,
): Promise<void> {
  // Error sink for the realtime subscriber's late rejection. The realtime
  // subscriber is fire-and-forget but its failure mode shouldn't be silent
  // — we await its promise just before persisting the outbox row so a
  // realtime throw still lands in `lastError`. By the time we get here the
  // socket frame has long since fired, so this await adds no perceptible
  // latency to the wire emit.
  const realtimeErrorSink: { error: string | null } = { error: null };
  const realtimePromise = runCriticalTier(event, realtimeErrorSink);

  // Spawn background tier DETACHED. The HTTP handler that called us isn't
  // forced to wait for analytics + workflow dispatch + outbound webhooks
  // before returning. Background errors are logged inside runBackgroundTier
  // (per-subscriber try/catch) — they don't propagate, so this promise always
  // resolves. We keep the handle (not `void`) so we can stamp dispatchedAt
  // only AFTER the background subscribers have actually created their rows.
  const backgroundPromise = runBackgroundTier(event);

  // Await realtime so its rejection (if any) makes it into the outbox row.
  if (realtimePromise) {
    try {
      await realtimePromise;
    } catch {
      // Already captured into the sink by runCriticalTier's catch wrapper.
    }
  }

  let rowId: string | null = null;
  try {
    rowId = await persistDispatchedRow(event, realtimeErrorSink.error);
  } catch (err) {
    console.error(
      withCorrelation(`[bus] outbox persist for "${event.type}" failed:`),
      err instanceof Error ? err.message : err,
    );
  }

  // Close the published→dispatched bracket ONLY after the detached background
  // tier resolves — i.e. after audit/analytics/workflow-dispatch/outbound-
  // webhook subscribers have created their rows. Detached from the HTTP
  // response (not awaited here), so response latency is unchanged, but a crash
  // mid-background now leaves publishedAt set + dispatchedAt NULL, which the
  // forensic "hard-crash loss window" query surfaces instead of a false-green
  // trail. Skip when realtime errored: persistDispatchedRow stamped failedAt,
  // and a failed row is intentionally KEPT undispatched for operator triage.
  if (rowId && !realtimeErrorSink.error) {
    const id = rowId;
    void backgroundPromise.then(() => queueDispatchedStamp(id)).catch(() => {});
  }
}

/**
 * Coalesce the dispatched-stamp UPDATEs.
 *
 * Every publish cost an `OutboundEvent` INSERT **plus** a separate one-row
 * UPDATE, on top of the entity write that triggered it. Under enterprise
 * inbound volume — or a broadcast fanning `message.sent` — that is an extra
 * round trip per event on the same pool the realtime emit and the inbox reads
 * are contending for. The drainer path already batches the identical call
 * (`markDispatched` takes an array and the drainer passes the whole
 * `dispatched[]`); only this synchronous path went one at a time.
 *
 * Safe to defer because the stamp is FORENSIC, not control flow: nothing reads
 * `dispatchedAt` to decide whether to publish, retry, or dedupe — it exists so
 * an operator can tell "crashed mid-background" (publishedAt set,
 * dispatchedAt NULL) from a clean run. Losing at most one window's worth of
 * stamps to a hard crash degrades exactly the same signal that a crash one
 * millisecond earlier would have degraded anyway, and `markDispatched` only
 * touches rows still `dispatchedAt: null`, so a late flush can't clobber
 * anything.
 *
 * Flushed on a short timer OR at a size cap, whichever comes first, so a
 * steady trickle is still stamped promptly and a burst can't grow the pending
 * array without bound. The timer is `unref`'d so it never holds the process
 * open during shutdown; `flushDispatchedStamps` is exported so the shutdown
 * path can drain it deliberately.
 */
const DISPATCH_STAMP_FLUSH_MS = 50;
const DISPATCH_STAMP_MAX_PENDING = 500;
let pendingDispatchIds: string[] = [];
let dispatchFlushTimer: ReturnType<typeof setTimeout> | null = null;

function queueDispatchedStamp(id: string): void {
  pendingDispatchIds.push(id);
  if (pendingDispatchIds.length >= DISPATCH_STAMP_MAX_PENDING) {
    void flushDispatchedStamps();
    return;
  }
  if (dispatchFlushTimer) return;
  dispatchFlushTimer = setTimeout(() => {
    dispatchFlushTimer = null;
    void flushDispatchedStamps();
  }, DISPATCH_STAMP_FLUSH_MS);
  dispatchFlushTimer.unref?.();
}

/** Write any queued dispatched stamps now. Idempotent; safe to call on drain. */
export async function flushDispatchedStamps(): Promise<void> {
  if (dispatchFlushTimer) {
    clearTimeout(dispatchFlushTimer);
    dispatchFlushTimer = null;
  }
  if (pendingDispatchIds.length === 0) return;
  const ids = pendingDispatchIds;
  pendingDispatchIds = [];
  try {
    await markDispatched(ids);
  } catch {
    // Best-effort, exactly as the per-row version was — a failed stamp leaves
    // the row looking like a crash-window row, which is the conservative read.
  }
}

/**
 * Dispatch a row that was already written to the outbox via
 * `publishInTx`. Runs subscribers but does NOT write another outbox row —
 * the row already exists; the drainer is responsible for marking it
 * `publishedAt`. Internal API; only the OutboxDrainerService should call.
 *
 * Returns an aggregated error message when ANY subscriber threw (otherwise
 * null) so the drainer can stamp `lastError` on the outbox row. Without
 * this the per-subscriber console.error is the ONLY trail — the row gets
 * marked `publishedAt` and looks delivered forever. The in-process
 * `publish()` path doesn't need this (the entity is already committed
 * regardless; the audit row carrying the error is best-effort), but for
 * drainer-dispatched events the row IS the durable record of dispatch
 * outcome — silent loss there is invisible.
 */
export async function dispatchPersistedEvent<K extends DomainEventType>(
  event: DomainEventOf<K>,
  perSubscriberTimeoutMs?: number,
): Promise<string | null> {
  const errors: string[] = [];
  await runAllSubscribersAwaited(event, errors, perSubscriberTimeoutMs);
  if (errors.length === 0) return null;
  // Bound the persisted message — `lastError` is bounded text and the
  // operator only needs the head of the trail. When truncating, prepend the
  // total count so the operator knows the displayed list is partial (silent
  // slicing previously hid >4-error fan-outs in stdout only).
  const SHOWN_LIMIT = 4;
  const total = errors.length;
  const shown = errors.slice(0, SHOWN_LIMIT).join(" | ");
  const composed =
    total > SHOWN_LIMIT
      ? `${total} total errors, showing first ${SHOWN_LIMIT}: ${shown}`
      : shown;
  return composed.slice(0, 1024);
}

/**
 * Critical tier: spawn the REALTIME subscriber fire-and-forget so the socket
 * frame is on the wire before any downstream subscriber runs. Returns the
 * realtime handler's promise (or null when there is no realtime subscriber)
 * so `publish()` can await it just-in-time before persisting the outbox row
 * — that's the M3 "ref/sink" pattern.
 */
function runCriticalTier<K extends DomainEventType>(
  event: DomainEventOf<K>,
  errorSink: { error: string | null },
): Promise<void> | null {
  const list = state.handlers.get(event.type as DomainEventType);
  if (!list || list.length === 0) return null;
  const first = list[0]!;
  if (first.priority !== SubscriberPriority.REALTIME) return null;
  // NOTE: only list[0] is treated as critical. More than one REALTIME
  // registration for the same event would leave the rest in the background
  // tier, decided by module-init order — see `criticalTierCount` below, which
  // makes that a boot-time assertion instead of a silent race.
  try {
    const maybe = first.handler(event as DomainEventOf<DomainEventType>);
    if (maybe && typeof (maybe as Promise<void>).then === "function") {
      return (maybe as Promise<void>).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          withCorrelation(`[bus] subscriber #0 (realtime) for "${event.type}" threw:`),
          msg,
        );
        errorSink.error = `#0(realtime): ${msg}`;
      });
    }
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      withCorrelation(`[bus] subscriber #0 (realtime) for "${event.type}" threw:`),
      msg,
    );
    errorSink.error = `#0(realtime): ${msg}`;
    return null;
  }
}

/**
 * Background tier: everything past REALTIME runs sequentially in priority
 * order. `workflow-dispatch` reads post-mutation state that `analytics`
 * writes; `outbound-webhooks` ships partner payloads carrying those same
 * fields. Parallel dispatch made both races inevitable in proportion to
 * subscriber latency. Each handler gets its own try/catch so a broken
 * subscriber can't poison the chain. Errors are logged only — this tier
 * runs DETACHED from `publish()`, so there's no caller awaiting an
 * aggregated trail. Consumers that need DURABILITY (redelivery across a
 * crash) must go through `publishInTx` + the drainer, which is at-least-once;
 * this synchronous path is best-effort by construction.
 *
 * When `list[0]` isn't REALTIME (events with a `null` fanout rule like
 * `contact.tag_changed`), the first real subscriber lives in this tier and
 * is awaited like any other.
 */
/**
 * Per-subscriber ceiling for the SYNCHRONOUS publish() path. The drainer got
 * one (DISPATCH_TIMEOUT_MS) precisely because a hung subscriber starves every
 * downstream tier — but publish() never had it, and the wedge watchdog does
 * not cover this path: a stuck Prisma call inside one subscriber pended the
 * whole background chain forever, silently, behind a green /health.
 */
const PUBLISH_SUBSCRIBER_TIMEOUT_MS = 30_000;

async function runBackgroundTier<K extends DomainEventType>(
  event: DomainEventOf<K>,
): Promise<void> {
  const list = state.handlers.get(event.type as DomainEventType);
  if (!list || list.length === 0) return;
  // Skip the REALTIME slot — it was already fired by `runCriticalTier`.
  const startIdx =
    list[0]!.priority === SubscriberPriority.REALTIME ? 1 : 0;
  for (let i = startIdx; i < list.length; i++) {
    const record = list[i]!;
    try {
      await withSubscriberTimeout(
        Promise.resolve(record.handler(event as DomainEventOf<DomainEventType>)),
        PUBLISH_SUBSCRIBER_TIMEOUT_MS,
        `subscriber #${i} for "${event.type}"`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        withCorrelation(`[bus] subscriber #${i} (background) for "${event.type}" threw:`),
        msg,
      );
    }
  }
}

/**
 * Drainer-side dispatch: awaits ALL tiers (realtime + background) and
 * collects every subscriber's error into `errorSink`. The drainer stamps
 * `lastError` from that sink so the operator's forensic query reflects the
 * actual outcome. Unlike `publish()`, the drainer is not on a hot-response
 * path — full awaiting is the correct posture.
 */
async function runAllSubscribersAwaited<K extends DomainEventType>(
  event: DomainEventOf<K>,
  errorSink: string[],
  perSubscriberTimeoutMs?: number,
): Promise<void> {
  const list = state.handlers.get(event.type as DomainEventType);
  if (!list || list.length === 0) return;
  for (let i = 0; i < list.length; i++) {
    const record = list[i]!;
    const label =
      record.priority === SubscriberPriority.REALTIME
        ? `#${i}(realtime)`
        : `#${i}`;
    try {
      // Timeout is applied PER-SUBSCRIBER (not once around the whole chain):
      // a single hung handler is recorded as an error and we CONTINUE to the
      // next one, so it can't starve every downstream subscriber of a
      // tx-durable event (which previously got permanently dropped with no
      // retry). A timed-out handler keeps running detached; we just stop
      // awaiting it.
      const handled = Promise.resolve(
        record.handler(event as DomainEventOf<DomainEventType>),
      );
      if (perSubscriberTimeoutMs && perSubscriberTimeoutMs > 0) {
        await withSubscriberTimeout(
          handled,
          perSubscriberTimeoutMs,
          `subscriber ${label} for "${event.type}"`,
        );
      } else {
        await handled;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        withCorrelation(`[bus] subscriber ${label} for "${event.type}" threw:`),
        msg,
      );
      errorSink.push(`${label}: ${msg}`);
    }
  }
}

/**
 * Race a single subscriber against a timeout. On timeout the returned promise
 * rejects (recorded as that subscriber's error by the caller) while the
 * handler's own promise keeps running detached — Promise.race can't cancel it,
 * but the point is only to stop BLOCKING the remaining subscribers.
 */
function withSubscriberTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]) as Promise<T>;
}
