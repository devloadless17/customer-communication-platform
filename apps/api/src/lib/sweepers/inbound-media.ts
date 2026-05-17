import "server-only";

import { db } from "@/lib/db";
import { publish } from "@/lib/events/bus";

/**
 * Garbage-collect inbound media rows that the phase-2 background download
 * never finished. The webhook handler kicks the binary-fetch off via
 * `void downloadInboundMedia(...)` AFTER returning 200 to Meta — perfectly
 * fine in steady state, but a process restart (deploy, OOM, systemd
 * `Restart=on-failure`, manual bump) drops every in-flight detached
 * promise on the floor. Without a sweeper, those rows stay forever with
 * `mediaKind` set + `mediaUrl` null, which the UI renders as a permanent
 * "Downloading…" placeholder (now a clean shimmer — even worse, looks
 * like the message will never load).
 *
 * Retry semantics: today we just CLEAR the stale media columns. The row
 * keeps its caption (in `body`) so the agent still sees what was sent —
 * just as a text-only bubble. True retry would need to re-extract Meta's
 * media id from the rawPayload JSONB and re-call fetchMedia + blob upload;
 * that's a larger change and orthogonal to "make the UI honest."
 *
 * Cadence: 1 min interval, 2 min stale threshold. Most downloads finish
 * within ~5s; anything still pending after 2 min is a restart casualty,
 * not slow throughput. Earlier values (5 min / 10 min) left agents staring
 * at a stuck "downloading…" placeholder for up to 15 min after every
 * deploy — too painful for pilot use.
 */

const SWEEP_INTERVAL_MS = 60 * 1000;
const STALE_THRESHOLD_MS = 2 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function startInboundMediaSweeper(): void {
  if (timer) return;
  // Run once on boot to clear casualties from the previous process. Then
  // settle into the periodic cadence.
  void sweepOnce().catch((err) =>
    console.error("[sweeper.inbound-media] initial sweep failed", err),
  );
  timer = setInterval(() => {
    void sweepOnce().catch((err) =>
      console.error("[sweeper.inbound-media] sweep failed", err),
    );
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
