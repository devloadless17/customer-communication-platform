import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import { withCorrelation } from "@/common/correlation";
import { runWithConcurrency } from "@/common/concurrency";
import {
  claimBatch,
  markPublishedWithError,
} from "@/lib/events/outbox";
import type {
  DomainEvent,
  DomainEventOf,
  DomainEventType,
} from "@ccp/shared/events/types";

// Import the class from the service file directly. Going through
// event-bus.module would re-introduce the circular import the service file
// was extracted to fix.
import { EventBus } from "./event-bus.service";

/**
 * Polls the OutboundEvent table for pending rows (the ones written via
 * `publishInTx(tx, event)` from inside a transaction) and dispatches them
 * to in-process subscribers.
 *
 * Semantics:
 *   - `claimBatch` marks the rows `publishedAt = NOW()` ATOMICALLY before
 *     dispatch. At-most-once delivery: a process crash mid-dispatch leaves
 *     `publishedAt IS NOT NULL` even though subscribers never fired. The
 *     row stays in the table as a forensic record.
 *   - Subscriber throws are logged. Per-row failures don't poison the batch.
 *   - If `claimBatch` itself returns more rows than the batch limit allows,
 *     the loop keeps pulling until the table is drained for that tick.
 *
 * Pace: polls every `POLL_INTERVAL_MS`. Under burst a single tick keeps
 * draining up to `MAX_DRAINS_PER_TICK` batches before yielding, so the true
 * ceiling is `BATCH_SIZE * MAX_DRAINS_PER_TICK * 1000 / POLL_INTERVAL_MS`
 * events/second (~20k/s at the defaults) — NOT the single-batch
 * `BATCH_SIZE * 1000 / POLL_INTERVAL_MS` (~2k/s) an earlier comment implied.
 * Non-tx `publish()` calls dispatch synchronously and aren't bounded by this.
 *
 * Lifecycle: started on module init, stopped on shutdown via
 * `OnModuleDestroy` (main.ts's manual SIGTERM/SIGINT handler calls
 * `app.close()`, which fires the NestJS lifecycle hooks).
 */
@Injectable()
export class OutboxDrainerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDrainerService.name);

  /**
   * Trade-off: shorter polls reduce socket-fanout latency for tx-context
   * publishes; longer polls reduce DB load. 100ms means a webhook ingest's
   * `contact.created` event reaches connected browsers in ≤100ms p99,
   * comfortably under the 500ms threshold where humans notice the lag.
   */
  private static readonly POLL_INTERVAL_MS = 100;

  /**
   * How many rows to dispatch per poll. A high-volume webhook batch (10
   * inbound messages) fans out as ~30-50 events; the cap prevents one tick
   * from holding the connection too long. Excess rows roll into the next
   * tick at the same 100ms cadence.
   */
  private static readonly BATCH_SIZE = 200;

  /**
   * Maximum drain loops per tick. If the table is hot enough that one
   * BATCH_SIZE worth of rows lands per drain, we keep draining within the
   * same poll cycle until empty OR this ceiling hits. Past the ceiling we
   * yield to the next poll so the loop never monopolises the event loop.
   */
  private static readonly MAX_DRAINS_PER_TICK = 10;

  /**
   * Bounded fan-out for per-row dispatch within a batch. 8 lanes mirrors the
   * outbound-webhook delivery fan; bounds the event-loop pressure of a hot
   * 200-row batch (each row runs the full subscriber chain) so one team's
   * burst can't pin the loop for every other tenant.
   */
  private static readonly DISPATCH_CONCURRENCY = 8;

  private timer: NodeJS.Timeout | null = null;
  private inflight = false;
  private stopping = false;

  constructor(private readonly bus: EventBus) {}

  onModuleInit(): void {
    this.schedule();
    this.logger.log(
      `outbox drainer started — poll=${OutboxDrainerService.POLL_INTERVAL_MS}ms ` +
        `batch=${OutboxDrainerService.BATCH_SIZE} maxDrainsPerTick=${OutboxDrainerService.MAX_DRAINS_PER_TICK}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Best-effort flush of anything still in-flight before exit. Bounded
    // generously (25s) — the compose `stop_grace_period` on the api
    // service is 100s, and the BullMQ worker drain owns the lion's share
    // (90s lockDuration + tail). 25s comfortably fits two full batches
    // through the new parallel-dispatch path even under slow-subscriber
    // worst case. The earlier 2s deadline routinely SIGKILL'd the drainer
    // mid-batch under burst load — its rows were pre-marked `publishedAt`
    // (at-most-once), so the side effects downstream of those subscribers
    // (audit rows, outbound webhook enqueues) were silently skipped.
    // The `this.stopping` check inside `tick`'s loop also lets in-flight
    // dispatches drain without picking up new batches.
    const flushDeadline = Date.now() + 25_000;
    while (this.inflight && Date.now() < flushDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.logger.log("outbox drainer stopped");
  }

  private schedule(): void {
    if (this.stopping) return;
    // Clear any existing pending timer first so two schedule() calls can't
    // leave two live timers racing (each setTimeout overwrites this.timer but
    // the orphaned handle still fires). Idempotent scheduling — exactly one
    // pending tick at a time.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, OutboxDrainerService.POLL_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.inflight) {
      // Previous tick still running — bail WITHOUT rescheduling. The running
      // tick's `finally` already calls schedule() when it completes, so a
      // reschedule here would create a second timer chain that double-dispatch
      // races (the in-flight guard catches most, but two timers compound over
      // time). Let the owner reschedule.
      return;
    }
    this.inflight = true;
    try {
      let drains = 0;
      while (drains < OutboxDrainerService.MAX_DRAINS_PER_TICK) {
        if (this.stopping) break;
        const rows = await claimBatch(OutboxDrainerService.BATCH_SIZE);
        if (rows.length === 0) break;
        // Dispatch rows in bounded-parallel lanes. Each `dispatch()` runs
        // the FULL subscriber chain (realtime + audit + analytics +
        // workflow-dispatch + outbound-webhooks). Sequential per-row
        // dispatch made a single 200-row batch take up to 15s under
        // moderate subscriber latency, with realtime emits visibly lagging
        // for the tail of the batch even though they're priority-0 inside
        // each event. DISPATCH_CONCURRENCY lanes (mirrors the outbound-webhook
        // lane fan) keep any one team's events from monopolizing the loop —
        // an UNBOUNDED Promise.all over a 200-row batch pushed every subscriber
        // chain into the event loop at once (the comment used to claim
        // concurrency:8 while the code fanned all 200; this now matches).
        //
        // Per-dispatch errors are caught inline (logged) so one bad row can't
        // abort the lane; per-subscriber errors are ALSO caught deeper by
        // `dispatchPersistedEvent` and recorded via `markPublishedWithError`.
        //
        // INVARIANT for new subscribers: parallel dispatch is correctness-
        // safe ONLY if every subscriber's writes are atomic at the DB
        // level (single `.update()` / predicate-gated `.updateMany()` /
        // `.create()` / `$transaction`). A subscriber that does
        // read-from-DB → mutate-in-JS → write-to-DB can race itself for
        // two events touching the same row. Current subscribers verified
        // safe 2026-05-29:
        //   - analytics: trackOn{Assigned,StatusChanged,OutboundMessage}
        //     all use direct `.update()` or predicate-gated `.updateMany()`.
        //   - audit: reads stage/tag names then INSERTS new event rows
        //     (no shared-row contention).
        //   - workflow-dispatch: reads fresh conversation snapshot then
        //     calls `dispatch()` whose create-then-enqueue is per-run
        //     idempotent (P2002 on @@unique).
        // If you add a subscriber that reads-then-writes a shared row,
        // either make the write predicate-gated or batch this back to
        // sequential dispatch per event.
        // claimBatch's outer `UPDATE … RETURNING` has no ORDER BY — Postgres
        // returns rows in physical-update order, not the inner CTE's createdAt
        // sort. Sorting by createdAt before dispatch makes the lanes START in
        // arrival order — BEST-EFFORT FIFO, NOT a guarantee: the 8 parallel
        // lanes still COMPLETE in arbitrary order, so two `message.sent` on the
        // SAME conversation in one batch can still emit out of order. Bounded
        // impact — the list-row preview self-corrects on the next mutation, and
        // two same-conversation events inside one 100ms batch is rare. A true
        // per-stream FIFO (partition by conversationId → sequential within a
        // partition, parallel across) is deferred until that race is observed.
        rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        await runWithConcurrency(
          rows,
          OutboxDrainerService.DISPATCH_CONCURRENCY,
          (row) =>
            this.dispatch(row).catch((err) => {
              this.logger.error(
                withCorrelation(`[outbox-drainer] dispatch row=${row.id} failed`),
                err instanceof Error ? err.message : String(err),
              );
            }),
        );
        drains += 1;
        if (rows.length < OutboxDrainerService.BATCH_SIZE) break;
      }
    } catch (err) {
      this.logger.error(
        withCorrelation("[outbox-drainer] tick failed"),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      this.inflight = false;
      this.schedule();
    }
  }

  /**
   * Reconstruct the typed DomainEvent from the row and hand it to the bus.
   * The bus's `publish()` would write ANOTHER outbox row + dispatch — we
   * don't want that. Use the lower-level dispatch hook instead.
   *
   * `teamId` is restored from the COLUMN, not the payload — `publishInTx`
   * destructures it out before storing (see outbox.ts:49), so it would be
   * undefined on the reconstructed event otherwise. The realtime fanout
   * rules read `e.teamId` to pick the team room, so a missing teamId
   * silently routes every inbound socket emit to `team:undefined` and
   * the user has to refresh to see new conversations.
   */
  private async dispatch(row: {
    id: string;
    teamId: string;
    type: string;
    payload: unknown;
    attempts: number;
  }): Promise<void> {
    const event = {
      type: row.type as DomainEventType,
      teamId: row.teamId,
      ...(row.payload as Record<string, unknown>),
    } as DomainEvent;

    try {
      // Returns aggregated subscriber-error message when any handler threw.
      // The row STAYS marked-published (at-most-once dispatch), but we
      // stamp `lastError` on it so the failure is queryable. Without this
      // a subscriber bug only leaves a console.error trail and the row
      // looks healthy forever.
      const subscriberError = await this.bus.dispatchOutboxRow(
        event as DomainEventOf<DomainEventType>,
      );
      if (subscriberError) {
        try {
          await markPublishedWithError(row.id, subscriberError);
        } catch (markErr) {
          this.logger.error(
            withCorrelation(`[outbox-drainer] markPublishedWithError row=${row.id}`),
            markErr instanceof Error ? markErr.message : String(markErr),
          );
        }
      }
    } catch (err) {
      // Per-subscriber errors are already swallowed inside runSubscribers
      // (and surfaced via the return value above); this catch is for
      // unexpected envelope problems (corrupted JSON, type missing from
      // the bus, etc.). The row's `publishedAt` is ALREADY set by
      // claimBatch — so we use markPublishedWithError (not markFailed,
      // whose `WHERE publishedAt IS NULL` predicate would silently match
      // zero rows and the error trail would only land in stdout).
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        withCorrelation(`[outbox-drainer] dispatch row=${row.id} type=${row.type}`),
        message,
      );
      try {
        await markPublishedWithError(row.id, message);
      } catch (markErr) {
        this.logger.error(
          withCorrelation(`[outbox-drainer] markPublishedWithError row=${row.id}`),
          markErr instanceof Error ? markErr.message : String(markErr),
        );
      }
    }
  }
}
