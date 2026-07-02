import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import { runWithCorrelationContext, withCorrelation } from "@/common/correlation";
import { runWithConcurrency } from "@/common/concurrency";
import {
  claimBatch,
  markDispatched,
  markPublishedWithError,
  setOutboxKickHandler,
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
 *   - The tick keeps pulling claims until `claimBatch` returns ZERO rows (the
 *     table is drained for this tick) or `MAX_DRAINS_PER_TICK` is hit. It does
 *     NOT stop on a short (`< BATCH_SIZE`) claim — the per-team fairness cap
 *     makes a single hot tenant's claim legitimately short while a backlog
 *     remains (see the `drains += 1` site for the full rationale).
 *
 * Pace: polls every `POLL_INTERVAL_MS`. Under burst a single tick keeps
 * draining up to `MAX_DRAINS_PER_TICK` claims before yielding. The per-CLAIM
 * size is gated BOTH by `BATCH_SIZE` AND by `PER_TEAM_BATCH_CAP` rows per team
 * (outbox.ts) — so a SINGLE tenant's ceiling is
 * `PER_TEAM_BATCH_CAP * MAX_DRAINS_PER_TICK * 1000 / POLL_INTERVAL_MS`
 * events/s (~10k/s at the current 100 × 10 × 10), and the aggregate across many
 * tenants is bounded by `BATCH_SIZE * MAX_DRAINS_PER_TICK * 1000 /
 * POLL_INTERVAL_MS` (~20k/s). Before the cap was raised + the short-claim break
 * removed, a lone tenant was throttled to `PER_TEAM_BATCH_CAP=4` rows per
 * single-claim tick = ~40 events/s. Non-tx `publish()` calls dispatch
 * synchronously and aren't bounded by this.
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

  /**
   * Per-row dispatch ceiling (obs-1). A subscriber that awaits something that
   * never resolves (a hung partner socket inside an outbound-webhook enqueue, a
   * pool-starved write) would otherwise keep its lane's promise pending forever,
   * so the tick's `runWithConcurrency` never resolves and `inflight` pins true —
   * wedging the WHOLE event surface (realtime, audit, analytics, workflows,
   * webhooks all ride this drainer) behind a green /health. Bounding each
   * dispatch lets the tick complete; the timed-out row stays undispatched (the
   * loss-window signal) + records `lastError`. Generous (30s) so a legitimately
   * slow batch never trips it.
   */
  private static readonly DISPATCH_TIMEOUT_MS = 30_000;

  /**
   * Wedge watchdog (obs-1). If a tick runs longer than this — e.g. `claimBatch`
   * itself hangs on a dead pool, outside the per-row timeout's reach — force the
   * inflight latch off + reschedule so the drainer self-heals instead of going
   * dark until a human notices. Safe: at-most-once is preserved by the
   * `publishedAt`-before-dispatch mark, so a second concurrent tick can never
   * re-claim the first's rows. Well above any legitimate tick (seconds).
   */
  private static readonly WATCHDOG_MS = 120_000;

  private timer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private inflight = false;
  private tickStartedAt: number | null = null;
  // Monotonic ownership token for the inflight latch. Each tick claims the latch
  // with a fresh token; only the holder of the CURRENT token may release it in
  // its finally. The watchdog (checkWedge) bumps this when it force-releases a
  // wedged tick, so that tick's eventual finally becomes a no-op instead of
  // clobbering a freshly-started tick's latch / spawning a second timer (minor#5).
  private tickToken = 0;
  private stopping = false;

  constructor(private readonly bus: EventBus) {}

  onModuleInit(): void {
    // Register the immediate-drain hook so a tx-context publish dispatches the
    // instant it commits, instead of waiting out the poll. The poll stays as
    // the durable fallback (a missed/early kick is harmless — see kick()).
    setOutboxKickHandler(() => this.kick());
    this.schedule();
    // Wedge watchdog: periodically check for a tick stuck past WATCHDOG_MS and
    // force it to release so the drainer self-heals (obs-1).
    this.watchdogTimer = setInterval(() => this.checkWedge(), 30_000);
    this.watchdogTimer.unref?.();
    this.logger.log(
      `outbox drainer started — poll=${OutboxDrainerService.POLL_INTERVAL_MS}ms ` +
        `batch=${OutboxDrainerService.BATCH_SIZE} maxDrainsPerTick=${OutboxDrainerService.MAX_DRAINS_PER_TICK}`,
    );
  }

  /**
   * Drain NOW instead of waiting for the next poll. Called right after an
   * outbox row commits (via `kickOutbox()`), so realtime + outbound-webhook
   * fan-out for inbound messages goes out in ~1ms, not up to POLL_INTERVAL_MS.
   *
   * Safe under the existing single-timer model: it only RE-SCHEDULES the one
   * poll timer to fire immediately (0ms) — it never starts a second timer
   * chain or calls tick() directly. If a tick is already running, it's a
   * no-op: that tick drains the table empty and its finally reschedules the
   * steady poll. Rapid kicks (a 30-message batch) coalesce into one 0ms tick.
   */
  kick(): void {
    if (this.stopping || this.inflight) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, 0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    // Drop the kick hook so a late post-commit kick during shutdown can't
    // reschedule a tick after we've started draining to exit.
    setOutboxKickHandler(null);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
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

  /**
   * Watchdog (obs-1): if a tick has been inflight past WATCHDOG_MS, the loop is
   * wedged (e.g. claimBatch hung on a dead pool) — force the latch off and
   * reschedule. At-most-once holds regardless (publishedAt-before-dispatch), so
   * a transient double-tick can't re-fire any row.
   */
  private checkWedge(): void {
    if (this.stopping || !this.inflight || this.tickStartedAt == null) return;
    const elapsed = Date.now() - this.tickStartedAt;
    if (elapsed < OutboxDrainerService.WATCHDOG_MS) return;
    this.logger.error(
      `[outbox-drainer] WEDGE DETECTED — tick inflight for ${Math.round(elapsed / 1000)}s ` +
        `(> ${OutboxDrainerService.WATCHDOG_MS / 1000}s); force-releasing the latch and rescheduling. ` +
        `Event fanout (realtime/audit/analytics/workflows/webhooks) was stalled.`,
    );
    // Bump the ownership token so the wedged tick's eventual finally sees a
    // mismatch and no-ops, instead of releasing the latch / rescheduling on
    // top of the tick we're about to start (minor#5).
    this.tickToken += 1;
    this.inflight = false;
    this.tickStartedAt = null;
    this.schedule();
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
    this.tickStartedAt = Date.now();
    const myToken = ++this.tickToken;
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
        // Collect rows that actually finished dispatch (subscribers ran, even
        // if one errored) so we can stamp `dispatchedAt` — closing the bracket
        // opened by claimBatch's pre-dispatch `publishedAt`. Rows that crash /
        // throw at the envelope level stay undispatched (the loss-window signal).
        const dispatched: string[] = [];
        await runWithConcurrency(
          rows,
          OutboxDrainerService.DISPATCH_CONCURRENCY,
          (row) =>
            this.dispatch(row, dispatched).catch((err) => {
              this.logger.error(
                withCorrelation(`[outbox-drainer] dispatch row=${row.id} failed`),
                err instanceof Error ? err.message : String(err),
              );
            }),
        );
        // One batched UPDATE — best-effort (a miss only loses the bracket
        // stamp, never re-dispatches). Never throws into the tick.
        await markDispatched(dispatched).catch((err) =>
          this.logger.warn(
            withCorrelation(`[outbox-drainer] markDispatched failed: ${err instanceof Error ? err.message : String(err)}`),
          ),
        );
        drains += 1;
        // Keep draining within this tick while ANY rows came back — do NOT
        // break on `rows.length < BATCH_SIZE`. The per-team fairness cap
        // (PER_TEAM_BATCH_CAP, outbox.ts) means a single hot tenant's claim
        // legitimately returns FEWER than BATCH_SIZE rows while a large backlog
        // still waits, so the old `< BATCH_SIZE` break stopped after one claim
        // and throttled that tenant to PER_TEAM_BATCH_CAP rows per 100ms tick.
        // The `rows.length === 0` break at the top of the loop is the real
        // "table drained" signal; MAX_DRAINS_PER_TICK still bounds the tick so
        // the loop can't monopolize the event loop. The only cost is at most
        // one extra empty (SKIP LOCKED) claim per tick at low volume.
      }
    } catch (err) {
      this.logger.error(
        withCorrelation("[outbox-drainer] tick failed"),
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      // Only release + reschedule if we still own the latch. If checkWedge
      // force-released this (wedged) tick — or a newer tick has since taken
      // over — tickToken has moved past ours, so skip: releasing here would
      // clobber the current owner's latch and start a second timer chain
      // (minor#5).
      if (this.tickToken === myToken) {
        this.inflight = false;
        this.tickStartedAt = null;
        this.schedule();
      }
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
  private async dispatch(
    row: {
      id: string;
      teamId: string;
      type: string;
      payload: unknown;
      attempts: number;
      chainDepth: number;
      correlationId: string | null;
    },
    dispatched: string[],
  ): Promise<void> {
    const event = {
      type: row.type as DomainEventType,
      teamId: row.teamId,
      ...(row.payload as Record<string, unknown>),
    } as DomainEvent;

    try {
      // Restore the publish-time correlation context (EVT-1) so subscribers that
      // read ALS — notably the outbound-webhook subscriber's getChainDepth() —
      // see the ORIGINATING request's loop counter instead of the default 0.
      // Without this every deferred `message.sent` webhook resets X-CCP-Depth to
      // 1, defeating the cross-system loop guard. Bound each dispatch with a
      // timeout (obs-1) so a hung subscriber can't wedge the tick.
      const subscriberError = await runWithCorrelationContext(
        { requestId: row.correlationId ?? row.id, chainDepth: row.chainDepth },
        () =>
          // Timeout is applied PER-SUBSCRIBER inside the bus (not once around
          // the whole chain) so one hung handler can't drop every downstream
          // subscriber for this tx-durable event with no retry.
          this.bus.dispatchOutboxRow(
            event as DomainEventOf<DomainEventType>,
            OutboxDrainerService.DISPATCH_TIMEOUT_MS,
          ),
      );
      // dispatchOutboxRow RETURNED → all subscribers ran (a subscriberError
      // means one threw but the rest ran — still "dispatched", not lost).
      // Record for the batched dispatchedAt stamp. The envelope-throw path
      // below does NOT record → that row stays the loss-window signal.
      dispatched.push(row.id);
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
