import { db } from "@/lib/db";
import {
  discardStoredRecording,
  downloadCallRecording,
  downloadCallTranscript,
  finalizeInAppRecording,
  transcribeInAppCallRecording,
} from "@/lib/media/call-recording-download";
import {
  callArtifactPoliciesFor,
  INAPP_TRANSCRIPT_RETRY_HORIZON_MS,
} from "@/lib/media/call-artifact-policy";
import { isPoolClosedError, withSweeperMutex } from "@/lib/sweepers/_mutex";
import type { Channel } from "@ccp/shared/types";

/**
 * Finish call-artifact work the steady-state path didn't live to complete.
 *
 * Two pipelines, one sweeper:
 *
 * META artifacts — retry downloads that failed transiently. The steady-state
 * path ([ingest-call.ts](../providers/ingest-call.ts)) downloads each artifact
 * in the background the moment its provider webhook lands. A row with a
 * mediaId set but its key null is an artifact we KNOW exists but haven't
 * persisted — usually a Meta-CDN or R2 blip during the inline attempt. Unlike
 * inbound message media (~30-day provider retention), both artifacts are
 * deleted provider-side 7 DAYS after their webhook, so the retry horizon is
 * deliberately tighter and there is no "downgrade" step — past the horizon the
 * media id is simply left in place as forensic trace of what was lost.
 *
 * IN-APP artifacts (browser-recorded calls; no mediaId ever) — the recording
 * only ever existed in the agent's browser and the transcript only ever comes
 * from our own STT call, so there is no upstream to re-fetch from and every
 * crash used to be PERMANENT, SILENT loss:
 *  - `finalize`: the call ended but `recordingKey` still points at the `.raw`
 *    interim (tab crash / final upload failed / remux died with the process).
 *    Replay the final-upload path: remux → publish → transcribe → retention.
 *  - `transcribe`: the recording finalized but the API restarted (or the STT
 *    provider was down) before a transcript was written. Re-drive
 *    `transcribeInAppCallRecording` from the stored bytes.
 *  - `discard`: transcription-only policy, transcript written, but the
 *    process died before the audio was dropped — the workspace said "don't
 *    record calls" and is still holding a recording.
 * Policy is re-read per row via `callArtifactPoliciesFor` (the same single
 * definition the request path uses). STT costs money, so IN-APP retries are
 * capped per row (`MAX_INAPP_ATTEMPTS`, process-local — a restart grants a
 * fresh cap, which keeps the bound simple and the loss window closed). The
 * Meta batch is throttle-only: its retries are free downloads racing the
 * provider's 7-day deletion, so the cap must never apply there.
 */

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Rows younger than this may still have the inline download in flight.
const INFLIGHT_GRACE_MS = 5 * 60 * 1000;
// Provider deletes the file 7 days after the webhook; endedAt is minutes
// before that webhook, so 6.5 days of retries stays safely inside the window.
const RECOVERY_HORIZON_MS = 6.5 * 24 * 60 * 60 * 1000;
// In-app: give the browser's own final upload (3 retries, backoff) and the
// detached transcription time to land before treating the state as stuck.
const INAPP_SETTLE_MS = 10 * 60 * 1000;
// In-app bytes live in OUR blob store and never expire; the horizon only
// bounds the candidate set and keeps a surprise transcript from appearing on
// a week-old call. Shared with `deriveTranscriptPending` so the UI's
// "Transcribing…" state and this sweeper's persistence agree by construction.
const INAPP_HORIZON_MS = INAPP_TRANSCRIPT_RETRY_HORIZON_MS;
// Minimum gap between attempts for the SAME row (process-local; a restart
// just triggers one fresh idempotent attempt).
const RETRY_THROTTLE_MS = 30 * 60 * 1000;
// Paid-work ceiling per IN-APP row per process lifetime (finalize/transcribe
// both end in an STT call when transcription is on). Deliberately NOT applied
// to the Meta batch: those downloads are free re-fetches racing a 7-day
// provider deletion, and capping them would turn a 90-minute CDN incident
// into permanent artifact loss — the whole 6.5-day horizon must stay live.
const MAX_INAPP_ATTEMPTS = 3;
// Each attempt buffers up to the recording cap and blocks on Meta/R2/STT —
// bound the batch so a backlog can't monopolize the process.
const MAX_ROWS_PER_TICK = 5;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
const lastAttemptAt = new Map<string, number>();
// In-app rows only — see MAX_INAPP_ATTEMPTS.
const attemptCounts = new Map<string, number>();

interface MetaRetriableRow {
  id: string;
  needsRecording: boolean;
  needsTranscript: boolean;
}

interface InAppRow {
  id: string;
  kind: "finalize" | "transcribe" | "discard";
  workspaceId: string;
  channel: Channel;
  channelConnectionId: string | null;
}

interface SweepBatch {
  meta: MetaRetriableRow[];
  inApp: InAppRow[];
}

function throttled(id: string, now: number): boolean {
  return (lastAttemptAt.get(id) ?? 0) >= now - RETRY_THROTTLE_MS;
}

function cappedOut(id: string): boolean {
  return (attemptCounts.get(id) ?? 0) >= MAX_INAPP_ATTEMPTS;
}

async function selectRetriable(
  // Test seam: the classification spec needs its fixture rows to survive the
  // per-tick slice on a shared dev database that may hold other candidates.
  inAppLimit: number = MAX_ROWS_PER_TICK,
): Promise<SweepBatch> {
  const now = Date.now();
  const metaRows = await db.call.findMany({
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

  // In-app candidates: rows with a recording and NO mediaIds (an in-app row
  // never has one — that is what distinguishes the two pipelines). Every
  // recorded call inside the window is a candidate ON PURPOSE — kind is
  // classified in JS below, and a healthy row costs exactly one policy read
  // per process lifetime (the discard check) before it is capped out.
  const inAppRows = await db.call.findMany({
    where: {
      recordingMediaId: null,
      transcriptMediaId: null,
      recordingKey: { not: null },
      endedAt: {
        not: null,
        lt: new Date(now - INAPP_SETTLE_MS),
        gt: new Date(now - INAPP_HORIZON_MS),
      },
      // Same in-flight grace as the Meta batch: the final upload / transcript
      // write bumps updatedAt, so a row touched moments ago may still have
      // the original detached transcription running — don't double-bill it.
      updatedAt: { lt: new Date(now - INFLIGHT_GRACE_MS) },
    },
    orderBy: { endedAt: "asc" },
    take: 50,
    select: {
      id: true,
      workspaceId: true,
      channel: true,
      recordingKey: true,
      transcriptKey: true,
      // The account lives on the THREAD (Call carries no column by design) —
      // the same pointer every call action resolves credentials through.
      conversation: { select: { channelConnectionId: true } },
    },
  });

  // Prune bookkeeping for rows that can no longer be candidates, keyed on the
  // last ATTEMPT time — NOT on absence from this tick's candidate set. Every
  // attempt writes the row, and both queries exclude rows touched within
  // INFLIGHT_GRACE_MS, so a row drops out of the candidate set for minutes
  // after each try: pruning on absence handed a permanently-failing in-app row
  // a fresh MAX_INAPP_ATTEMPTS budget on the next tick, and the paid-STT
  // ceiling never bound. An entry older than the in-app horizon can never
  // return (the horizon bounds the candidate window), so it is safe to forget.
  const forgetBefore = now - INAPP_HORIZON_MS;
  for (const [id, at] of lastAttemptAt) {
    if (at < forgetBefore) {
      lastAttemptAt.delete(id);
      attemptCounts.delete(id);
    }
  }

  const meta = metaRows
    .filter((r) => !throttled(r.id, now))
    .slice(0, MAX_ROWS_PER_TICK)
    .map((r) => ({
      id: r.id,
      needsRecording: r.recordingMediaId !== null && r.recordingKey === null,
      needsTranscript: r.transcriptMediaId !== null && r.transcriptKey === null,
    }));

  const inApp = inAppRows
    .filter((r) => !throttled(r.id, now) && !cappedOut(r.id))
    .map((r): InAppRow => ({
      id: r.id,
      kind: r.recordingKey!.endsWith(".raw")
        ? "finalize"
        : r.transcriptKey === null
          ? "transcribe"
          : "discard",
      workspaceId: r.workspaceId,
      channel: r.channel as Channel,
      channelConnectionId: r.conversation.channelConnectionId,
    }))
    // Finalize first (it unblocks playback AND transcription), then missing
    // transcripts, then retention checks — under one shared per-tick budget.
    .sort(
      (a, b) =>
        ["finalize", "transcribe", "discard"].indexOf(a.kind) -
        ["finalize", "transcribe", "discard"].indexOf(b.kind),
    )
    .slice(0, inAppLimit);

  return { meta, inApp };
}

async function processInAppRow(row: InAppRow): Promise<void> {
  const policy = await callArtifactPoliciesFor(
    row.workspaceId,
    row.channel,
    row.channelConnectionId,
  );
  switch (row.kind) {
    case "finalize":
      // Finalize even when the policy has since been turned off — the audio
      // already exists and stranding it at `.raw` serves nobody; retention
      // below still honors what the workspace wants KEPT.
      await finalizeInAppRecording(row.id, {
        transcribe: policy.transcriptionEnabled,
        retainRecording: policy.recordingEnabled,
      });
      return;
    case "transcribe": {
      if (!policy.transcriptionEnabled) {
        // Recording-only workspace: nothing missing. Cap it out so the row
        // stops occupying the candidate set.
        attemptCounts.set(row.id, MAX_INAPP_ATTEMPTS);
        return;
      }
      const ok = await transcribeInAppCallRecording(row.id);
      if (ok && !policy.recordingEnabled) await discardStoredRecording(row.id);
      return;
    }
    case "discard":
      if (!policy.recordingEnabled && policy.transcriptionEnabled) {
        // discardStoredRecording re-checks the transcript itself; a row whose
        // policy wants the audio kept simply never reaches this branch.
        await discardStoredRecording(row.id);
      }
      // One check answers this row for the process lifetime.
      attemptCounts.set(row.id, MAX_INAPP_ATTEMPTS);
      return;
  }
}

async function runTick(label: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Mutex covers only the DB scan; the network-bound downloads run outside
    // it (same split as the inbound-media sweeper, for the same reason: a
    // Meta/R2 outage must not starve every other mutex-protected sweeper).
    const batch = (await withSweeperMutex("call-recordings", selectRetriable)) ?? {
      meta: [],
      inApp: [],
    };
    for (const row of batch.meta) {
      // Throttle only — NO attempt cap on this batch. The provider deletes
      // the upstream file 7 days post-webhook; every 30-minute slot inside
      // the horizon must stay usable or a transient outage becomes loss.
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
    for (const row of batch.inApp) {
      lastAttemptAt.set(row.id, Date.now());
      attemptCounts.set(row.id, (attemptCounts.get(row.id) ?? 0) + 1);
      try {
        await processInAppRow(row);
      } catch (err) {
        console.warn(
          `[sweeper.call-recordings] in-app ${row.kind} failed for call=${row.id}: ${
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
  attemptCounts.clear();
}

/** Test seam: one synchronous pass, no timers. */
export async function sweepCallRecordingsOnce(): Promise<void> {
  await runTick("test sweep");
}

/** Test seam: forget throttle/attempt bookkeeping between cases. */
export function resetCallRecordingSweeperStateForTests(): void {
  lastAttemptAt.clear();
  attemptCounts.clear();
}

/**
 * Test seam. `selectRetriable` reads globally (the spec filters to its own
 * rows); `processInAppRow` mutates only the row it is handed, so a spec can
 * drive recovery for ITS calls without a global sweep touching a shared dev
 * database's other rows mid-flight.
 */
export const __testing__ = { selectRetriable, processInAppRow };
