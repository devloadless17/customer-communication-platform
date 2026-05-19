import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";

/**
 * Garbage-collect any inbound message row left with `mediaKind` set +
 * `mediaUrl` null. After the in-band media flow landed in
 * [webhooks/meta/meta.controller.ts](../../webhooks/meta/meta.controller.ts)
 * the steady-state path never produces such rows — the binary is fetched
 * + uploaded before `ingestEvents` runs, so the row is created with media
 * columns populated or with `evt.media` dropped (text-only fallback).
 *
 * The sweeper is kept as a one-shot transition tidy (clears straggler
 * `mediaPending` rows from before the fix deployed) and as defense-in-depth
 * for any future failure mode that re-introduces a partial write. Without
 * it, such a row would render as a permanent shimmer in the UI.
 *
 * Retry semantics: we just CLEAR the stale media columns. The row keeps
 * its caption in `body` so the agent still sees what was sent — just as a
 * text-only bubble.
 */

const SWEEP_INTERVAL_MS = 60 * 1000;
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
// In-flight guard — prevents a slow sweep (large batched UPDATE + N media-
// ready publishes) from overlapping with the next interval tick. The
// publishes are bus-only so a double-publish would re-emit the same
// "ready" frame to clients, which would harmlessly re-clear an already-
// cleared placeholder, but the explicit flag keeps the contract clear.
let inFlight = false;

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await sweepOnce();
  } catch (err) {
    console.error(`[sweeper.inbound-media] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startInboundMediaSweeper(): void {
  if (timer) return;
  // Run once on boot to clear casualties from the previous process. Then
  // settle into the periodic cadence.
  void runTick("initial sweep");
  timer = setInterval(() => {
    void runTick("sweep");
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

export function stopInboundMediaSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function sweepOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  // Find inbound rows whose phase-2 download never landed. Outbound rows
  // never go through the pending state (the send route writes media columns
  // synchronously or not at all), so the `direction = "in"` predicate is
  // both a safety guard and lets the partial inbound index do the work.
  const stuck = await db.message.findMany({
    where: {
      direction: "in",
      mediaKind: { not: null },
      mediaUrl: null,
      createdAt: { lt: cutoff },
    },
    select: { id: true, teamId: true, conversationId: true },
    take: 100,
  });

  if (stuck.length === 0) return;

  // Clear in one batched UPDATE — far cheaper than per-row when the queue
  // got large after a long outage.
  const ids = stuck.map((r) => r.id);
  await db.message.updateMany({
    where: { id: { in: ids } },
    data: {
      mediaKind: null,
      mediaMimeType: null,
      mediaCaption: null,
      mediaFilename: null,
      mediaDurationMs: null,
      mediaKey: null,
      mediaUrl: null,
      mediaSizeBytes: null,
    },
  });

  // Tell every live client to drop the pending placeholder. Same payload
  // shape as the success path: omit `media` so the bubble strips its
  // media block and renders as a regular text row.
  for (const row of stuck) {
    await publish({
      type: "message.media_ready",
      teamId: row.teamId,
      conversationId: row.conversationId,
      messageId: row.id,
      // No media → socket-fanout emits the "ready" event without payload.
    });
  }

  console.warn(
    `[sweeper.inbound-media] cleared ${stuck.length} stuck pending media row(s)`,
  );
}
