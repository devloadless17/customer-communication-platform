import { db } from "@/lib/db";
import {
  downloadCallRecording,
  downloadCallTranscript,
} from "@/lib/media/call-recording-download";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";

/**
 * Retry call-artifact downloads (recordings AND transcripts) that failed
 * transiently.
 *
 * The steady-state path ([ingest-call.ts](../providers/ingest-call.ts))
 * downloads each artifact in the background the moment its provider webhook
 * (`call_recording_available` / `call_transcription_available`) lands. A row
 * with a mediaId set but its key null is an artifact we KNOW exists but
 * haven't persisted — usually a Meta-CDN or R2 blip during the inline
 * attempt.
 *
 * Unlike inbound message media (~30-day provider retention), both artifacts
 * are deleted provider-side 7 DAYS after their webhook, so the retry horizon
 * is deliberately tighter and there is no "downgrade" step — past the horizon
 * the media id is simply left in place as forensic trace of what was lost.
 */

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Rows younger than this may still have the inline download in flight.
const INFLIGHT_GRACE_MS = 5 * 60 * 1000;
// Provider deletes the file 7 days after the webhook; endedAt is minutes
// before that webhook, so 6.5 days of retries stays safely inside the window.
const RECOVERY_HORIZON_MS = 6.5 * 24 * 60 * 60 * 1000;
// Minimum gap between attempts for the SAME row (process-local; a restart
// just triggers one fresh idempotent attempt).
const RETRY_THROTTLE_MS = 30 * 60 * 1000;
// Each attempt buffers up to the recording cap and blocks on Meta/R2 —
// bound the batch so a backlog can't monopolize the process.
const MAX_ROWS_PER_TICK = 5;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
const lastAttemptAt = new Map<string, number>();

interface RetriableRow {
  id: string;
  needsRecording: boolean;
  needsTranscript: boolean;
}

async function selectRetriable(): Promise<RetriableRow[]> {
  const now = Date.now();
  const rows = await db.call.findMany({
    where: {
      OR: [
        { recordingMediaId: { not: null }, recordingKey: null },
        { transcriptMediaId: { not: null }, transcriptKey: null },
      ],
      // endedAt anchors the horizon; the webhooks land ~1min after it.
      endedAt: { gt: new Date(now - RECOVERY_HORIZON_MS) },
      updatedAt: { lt: new Date(now - INFLIGHT_GRACE_MS) },
    },
    orderBy: { endedAt: "asc" },
    take: 50,
    select: {
      id: true,
      recordingMediaId: true,
      recordingKey: true,
      transcriptMediaId: true,
      transcriptKey: true,
    },
  });
  // Prune resolved/expired entries so the throttle map tracks only live rows.
  const liveIds = new Set(rows.map((r) => r.id));
  for (const id of lastAttemptAt.keys()) {
    if (!liveIds.has(id)) lastAttemptAt.delete(id);
  }
  return rows
    .filter((r) => (lastAttemptAt.get(r.id) ?? 0) < now - RETRY_THROTTLE_MS)
    .slice(0, MAX_ROWS_PER_TICK)
    .map((r) => ({
      id: r.id,
      needsRecording: r.recordingMediaId !== null && r.recordingKey === null,
      needsTranscript: r.transcriptMediaId !== null && r.transcriptKey === null,
    }));
}

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Mutex covers only the DB scan; the network-bound downloads run outside
    // it (same split as the inbound-media sweeper, for the same reason: a
    // Meta/R2 outage must not starve every other mutex-protected sweeper).
    const rows = (await withSweeperMutex("call-recordings", selectRetriable)) ?? [];
    for (const row of rows) {
      lastAttemptAt.set(row.id, Date.now());
      try {
        let ok = true;
        if (row.needsRecording) ok = (await downloadCallRecording(row.id)) && ok;
        if (row.needsTranscript) ok = (await downloadCallTranscript(row.id)) && ok;
        if (ok) lastAttemptAt.delete(row.id);
      } catch (err) {
        console.warn(
          `[sweeper.call-recordings] retry failed for call=${row.id}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  } catch (err) {
    if (isPoolClosedError(err)) {
      stopCallRecordingSweeper();
      return;
    }
    console.error(`[sweeper.call-recordings] ${label} failed`, err);
  } finally {
    inFlight = false;
  }
}

export function startCallRecordingSweeper(): void {
  if (timer) return;
  void runTick("initial sweep");
  timer = setInterval(() => {
    void runTick("sweep");
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

export function stopCallRecordingSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastAttemptAt.clear();
}
