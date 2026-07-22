import { CallStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Backstop for Call rows that never reach a terminal state. A live call
 * converges to terminal via either (a) Meta's `terminate` webhook ingesting,
 * or (b) a browser POSTing `/end`. Both can be permanently lost:
 *   - the webhook controller deliberately DROPS a permanently-failing batch
 *     with a 200 (so Meta stops retrying), and
 *   - an unanswered INBOUND ring has no browser-side `/end` path (the toast
 *     just expires at 60s client-side; nobody calls the server).
 *
 * Without convergence the row sits `ringing`/`in_progress` forever, and
 * `liveCount()` (the team "Calls" badge) counts it forever — the same
 * stuck-badge bug class this codebase has repeatedly paid for in unread
 * counts. This sweeper terminalizes the stragglers and publishes the matching
 * terminal phase so the badge clears and any live thread pill resolves:
 *
 *   - `ringing` older than RINGING_STALE_MS  → `missed`  (call.missed)
 *   - `in_progress` older than INPROGRESS_MAX_MS → `failed` (call.failed)
 *
 * Both phases fan out a `call:ended` frame to the team room (fanout-rules),
 * so the live-count badge refetches and any client tears down. The thresholds
 * sit well past the real call envelope (Meta stops ringing < 60s; WhatsApp
 * calls don't run for hours) so a genuinely-live call is never killed.
 *
 * Idempotent + race-safe: every terminalize is a CAS `updateMany` gated on the
 * row STILL being in the source status, so a concurrent webhook/REST terminate
 * wins and we skip the publish for any row we didn't actually flip.
 */

const SWEEP_INTERVAL_MS = 60 * 1000;
// A ring open this long is dead. Meta documents a 30-60s window from the call
// webhook before it terminates the call itself with "Not Answered" and sends a
// terminate webhook — so a row still ringing after 3 minutes means that webhook
// never arrived, not that someone is still deciding. The margin over 60s covers
// clock skew and delayed delivery; the terminal-state guard in ingest makes a
// late terminate a harmless no-op if one does show up afterwards.
const RINGING_STALE_MS = 3 * 60 * 1000;
// An in-progress call open this long never got its terminate webhook. This
// ceiling is OURS, not the provider's — no maximum call duration is documented
// — so it's set generously enough that it can only ever catch a stuck row, not
// cut off a real conversation.
const INPROGRESS_MAX_MS = 2 * 60 * 60 * 1000;
const BATCH = 100;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await withSweeperMutex("stale-calls", sweepOnce);
  } catch (err) {
    // Pool already ended (dev hot-reload / shutdown) — the work is
    // over, so stop instead of logging a stack trace every tick.
    if (isPoolClosedError(err)) {
      stopStaleCallsSweeper();
      return;
    }
    console.error(`[sweeper.stale-calls] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startStaleCallsSweeper(): void {
  if (timer) return;
  // Run once on boot to clear stragglers left by a process death mid-call.
  void runTick("initial sweep");
  timer = setInterval(() => {
    void runTick("sweep");
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

export function stopStaleCallsSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  const now = Date.now();
  const ringingCutoff = new Date(now - RINGING_STALE_MS);
  const inProgressCutoff = new Date(now - INPROGRESS_MAX_MS);

  // Stale RINGING rows → missed. Keyed off ringingAt; the (workspaceId,status,
  // ringingAt) index serves this filter.
  const stuckRinging = await db.call.findMany({
    where: {
      status: CallStatus.ringing,
      ringingAt: { lt: ringingCutoff },
    },
    select: { id: true, workspaceId: true, conversationId: true, ringingAt: true },
    take: BATCH,
  });

  for (const row of stuckRinging) {
    const endedAt = new Date();
    const flip = await db.call.updateMany({
      where: { id: row.id, status: CallStatus.ringing },
      data: { status: CallStatus.missed, endedAt },
    });
    if (flip.count === 0) continue; // a real terminate won the race
    // The flip already committed (the row won't be re-selected), so isolate the
    // notify: a single failed publish must not abort the loop and leave every
    // later stuck call un-terminalized — that's the stuck-Calls-badge class.
    try {
      await publish({
        type: "call.missed",
        workspaceId: row.workspaceId,
        conversationId: row.conversationId,
        callId: row.id,
        ringingAt: row.ringingAt.toISOString(),
      });
    } catch (err) {
      console.warn(
        `[sweeper.stale-calls] missed publish failed for ${row.id} (DB flipped; badge resyncs on reload)`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Stale IN_PROGRESS rows → failed. We can't know the real talk-time (no
  // terminate landed), so durationSeconds stays null and we record `failed`
  // rather than `completed`: the call connected but ended without evidence.
  const stuckInProgress = await db.call.findMany({
    where: {
      status: CallStatus.in_progress,
      ringingAt: { lt: inProgressCutoff },
    },
    select: { id: true, workspaceId: true, conversationId: true },
    take: BATCH,
  });

  for (const row of stuckInProgress) {
    const endedAt = new Date();
    const flip = await db.call.updateMany({
      where: { id: row.id, status: CallStatus.in_progress },
      data: { status: CallStatus.failed, endedAt },
    });
    if (flip.count === 0) continue;
    try {
      await publish({
        type: "call.failed",
        workspaceId: row.workspaceId,
        conversationId: row.conversationId,
        callId: row.id,
        reason: "no_terminate_webhook",
        endedAt: endedAt.toISOString(),
      });
    } catch (err) {
      console.warn(
        `[sweeper.stale-calls] failed publish failed for ${row.id} (DB flipped; badge resyncs on reload)`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const total = stuckRinging.length + stuckInProgress.length;
  if (total > 0) {
    console.warn(
      `[sweeper.stale-calls] terminalized ${stuckRinging.length} stale ringing + ${stuckInProgress.length} stale in-progress call(s)`,
    );
  }
}
