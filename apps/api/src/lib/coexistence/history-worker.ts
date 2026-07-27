// WhatsApp Coexistence history-backfill worker. Framework-agnostic BullMQ
// consumer (sibling to lib/workflows/worker.ts + lib/outbound-webhooks/worker.ts);
// the NestJS lifecycle harness (CoexistenceWorkerService) starts/stops it so an
// in-flight chunk drains before the process exits.
//
// A job carries the raw Meta `history` webhook payload. We re-parse it with the
// same provider parser the live path uses, then land each historical message via
// the QUIET `ingestHistoricalMessage` (no unread bump, no workflow/webhook
// fanout, no per-message socket frame — see that function). Idempotent by wamid.

import { Worker, type Job } from "bullmq";
import type IORedis from "ioredis";

import { recordJobFailure } from "@/common/job-failure-metrics";
import { getMetaProvider } from "@/lib/providers";
import { ingestHistoricalMessage, isTransientDbError } from "@/lib/providers/ingest";
import { createWorkerConnection } from "@/lib/workflows/queue";
import type { NormalizedEvent } from "@ccp/shared/providers/types";

import {
  COEXISTENCE_HISTORY_QUEUE_NAME,
  type HistoryJobData,
} from "./history-queue";

// One chunk is pure DB inserts; a single-lane worker keeps the backfill from
// contending with live inbound ingest for the connection pool. Bumpable via env
// if a large migration needs to go faster.
function concurrency(): number {
  const raw = Number.parseInt(process.env.HISTORY_WORKER_CONCURRENCY ?? "1", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 8 ? raw : 1;
}

// A chunk of a few thousand rows can take a while; give the lock generous room
// and keep the close-cap under api's compose `stop_grace_period: 100s`.
const HISTORY_LOCK_DURATION_MS = 90_000;
const HISTORY_CLOSE_TIMEOUT_MS = 30_000;

interface WorkerGlobals {
  worker?: Worker<HistoryJobData>;
  connection?: IORedis;
  shuttingDown?: boolean;
}
const g = globalThis as unknown as { __ccpHistoryWorker?: WorkerGlobals };
const state: WorkerGlobals = (g.__ccpHistoryWorker ??= {});

export function startHistoryWorker(): Worker<HistoryJobData> {
  if (state.worker) return state.worker;
  state.shuttingDown = false;

  const connection = createWorkerConnection("coexistence-history-worker");
  state.connection = connection;

  const worker = new Worker<HistoryJobData>(
    COEXISTENCE_HISTORY_QUEUE_NAME,
    async (job: Job<HistoryJobData>) => {
      const { workspaceId, payload } = job.data;
      let events: NormalizedEvent[];
      try {
        events = getMetaProvider().parseWebhook(payload);
      } catch (err) {
        // A malformed chunk is permanent poison — log + swallow so BullMQ
        // doesn't retry-storm it. (Throwing would burn all 5 attempts.)
        console.error(
          `[coexistence-history] parse failed for team=${workspaceId}; dropping chunk:`,
          err instanceof Error ? err.message : err,
        );
        return;
      }

      let landed = 0;
      let poisoned = 0;
      for (const evt of events) {
        // PER-EVENT ISOLATION, like the live ingest path (`runOne`).
        //
        // Without it, one throw rejected the whole job: BullMQ replayed the
        // chunk from index 0, re-hit the same event, burned all 5 attempts and
        // dead-lettered — so EVERY message after the poison event in that
        // chunk was lost permanently. This is history the customer can never
        // re-fetch (the controller's own comment says exactly that), which
        // makes "skip the one bad event" strictly better than "lose the tail".
        //
        // Transient DB errors are the exception: those SHOULD fail the job so
        // BullMQ retries the chunk, exactly as the live path re-throws them.
        try {
        // The history parser only ever emits inbound messages + business echoes.
        // Coexistence history is WhatsApp-only, so contactPhone is always set;
        // the guard just satisfies the now-optional identity type.
        if (evt.kind === "message" && evt.contactPhone) {
          await ingestHistoricalMessage(workspaceId, "whatsapp", {
            externalId: evt.externalId,
            contactPhone: evt.contactPhone,
            body: evt.body,
            media: evt.media,
            timestamp: evt.timestamp,
            direction: "in",
            rawPayload: evt.rawPayload,
          });
          landed++;
        } else if (evt.kind === "echo") {
          // Coexistence echoes always carry a phone (WhatsApp); the field is now
          // optional on the shared type (social echoes use externalContactId).
          if (!evt.contactPhone) continue;
          await ingestHistoricalMessage(workspaceId, "whatsapp", {
            externalId: evt.externalId,
            contactPhone: evt.contactPhone,
            body: evt.body,
            media: evt.media,
            timestamp: evt.timestamp,
            direction: "out",
            rawPayload: evt.rawPayload,
          });
          landed++;
        }
        } catch (err) {
          if (isTransientDbError(err)) throw err;
          poisoned++;
          console.warn(
            JSON.stringify({
              event: "coexistence.history_event_skipped",
              severity: "warn",
              // `externalId` isn't on every NormalizedEvent variant; the two
              // this loop handles both carry it.
              externalId: "externalId" in evt ? evt.externalId : null,
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
      if (poisoned > 0) {
        console.warn(
          `[coexistence-history] skipped ${poisoned} unprocessable event(s); ${landed} landed`,
        );
      }
      console.log(
        JSON.stringify({
          event: "coexistence.history_chunk_ingested",
          workspaceId,
          landed,
        }),
      );
    },
    {
      connection,
      concurrency: concurrency(),
      lockDuration: HISTORY_LOCK_DURATION_MS,
      lockRenewTime: 30_000,
      stalledInterval: 30_000,
      maxStalledCount: 3,
    },
  );

  worker.on("failed", (job, err) => {
    console.warn(
      `[coexistence-history] chunk ${job?.id} failed (attempt ${job?.attemptsMade}/${
        job?.opts.attempts ?? 1
      }): ${err.message}`,
    );
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      recordJobFailure("coexistence-history", job.id, err.message);
    }
  });

  worker.on("error", (err) => {
    console.error("[coexistence-history] worker error", err);
    const msg = err instanceof Error ? err.message : String(err);
    const fatal =
      msg.includes("Connection is closed") ||
      msg.includes("WRONGPASS") ||
      msg.includes("NOAUTH");
    // Only the currently-registered worker may clear the shared slot — a late
    // error from a superseded worker must not blank the live replacement.
    if (fatal && !state.shuttingDown && state.worker === worker) {
      console.warn("[coexistence-history] worker unrecoverable; re-spawning");
      worker.close().catch(() => undefined);
      connection.disconnect();
      state.worker = undefined;
      state.connection = undefined;
      setTimeout(() => {
        if (!state.shuttingDown) startHistoryWorker();
      }, 1_000).unref();
    }
  });

  state.worker = worker;
  console.log(`[coexistence-history] worker started, concurrency=${concurrency()}`);
  return worker;
}

export async function stopHistoryWorker(): Promise<void> {
  state.shuttingDown = true;
  if (!state.worker) return;
  await Promise.race([
    state.worker.close(),
    new Promise<void>((_resolve, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `[coexistence-history] worker.close() exceeded ${HISTORY_CLOSE_TIMEOUT_MS}ms — abandoning drain`,
            ),
          ),
        HISTORY_CLOSE_TIMEOUT_MS,
      ).unref(),
    ),
  ]).catch((err) => console.error(err instanceof Error ? err.message : err));
  state.connection?.disconnect();
  state.connection = undefined;
  state.worker = undefined;
}
