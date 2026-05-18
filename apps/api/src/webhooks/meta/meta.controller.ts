import { createHmac, timingSafeEqual } from "node:crypto";

import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";

import { blobStorage } from "@/lib/blob-storage";
import { publish } from "@/lib/events/bus";
import { MEDIA_SIZE_CAPS } from "@/lib/media-storage";
import { getMetaProvider } from "@/lib/providers";
import { getMetaSendConfig, getMetaWebhookConfig } from "@/lib/providers/config";
import { ingestEvents } from "@/lib/providers/ingest";
import type { NormalizedEvent } from "@ccp/shared/providers/types";

import { DbService } from "../../db/db.service";

/**
 * Per-team Meta WhatsApp Cloud API webhook.
 *
 *   GET  /webhooks/meta/:teamId   → one-time subscription verify challenge
 *   POST /webhooks/meta/:teamId   → real events; HMAC over the raw body
 *
 * Ported from
 * [app/api/webhooks/meta/[teamId]/route.ts](../../../../../../app/api/webhooks/meta/%5BteamId%5D/route.ts) —
 * same shape, same fail-soft posture (malformed payloads still return 200 so
 * Meta doesn't retry-storm). Caddy will start routing `/webhooks/*` to this
 * controller as part of the Phase 2 cutover; the Next.js route stays in
 * place until that flip so a misconfigured Caddy isn't a webhook outage.
 *
 * Multi-tenancy: `teamId` in the path is a routing signal, NOT proof of
 * origin. The HMAC against the team's per-tenant `metaAppSecret` is the
 * actual authentication.
 */
@Controller("webhooks/meta")
export class MetaWebhookController {
  private readonly logger = new Logger(MetaWebhookController.name);

  constructor(private readonly db: DbService) {}

  @Get(":teamId")
  async verify(
    @Param("teamId") teamId: string,
    @Query("hub.mode") mode: string | undefined,
    @Query("hub.verify_token") token: string | undefined,
    @Query("hub.challenge") challenge: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const config = await getMetaWebhookConfig(teamId);
    if (!config) {
      // Silent 403 — leaking "team unconfigured" vs "team not found" gives
      // attackers a teamId enumeration oracle on a public endpoint.
      res.status(403).type("text/plain").send("forbidden");
      return;
    }
    if (mode === "subscribe" && token === config.verifyToken && challenge) {
      res.status(200).type("text/plain").send(challenge);
      return;
    }
    res.status(403).type("text/plain").send("forbidden");
  }

  @Post(":teamId")
  @HttpCode(200)
  async receive(
    @Param("teamId") teamId: string,
    @Headers("x-hub-signature-256") signature: string | undefined,
    @Req() req: Request,
  ): Promise<{ ok: boolean; ingested?: number; dropped?: string }> {
    const config = await getMetaWebhookConfig(teamId);
    if (!config) throw new HttpException("forbidden", 403);

    // Verify against the EXACT bytes Meta signed. main.ts's bodyParser
    // captures req.rawBody on every JSON-parsed request. Without it,
    // JSON.stringify(req.body) would silently invalidate the HMAC on any
    // whitespace difference.
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      this.logger.error(
        `[${teamId}] missing rawBody — main.ts verify hook regressed?`,
      );
      throw new HttpException("server misconfigured", 500);
    }
    if (!verifySignature(rawBody, signature, config.appSecret)) {
      throw new HttpException("forbidden", 403);
    }

    // Body is already parsed by main.ts's bodyParser.json — req.body has it.
    const payload = req.body as unknown;
    const events = getMetaProvider().parseWebhook(payload);
    if (events.length === 0) return { ok: true, ingested: 0 };

    // Hybrid in-band / async media flow. Race the binary download against
    // a tight budget:
    //   - If the download finishes inside the budget, ingest creates the row
    //     with media columns populated → single `message:new` emit carries
    //     the full image. No shimmer.
    //   - If the budget expires first, ingest commits a `mediaPending` row
    //     (~100ms after webhook receipt) so the bubble appears instantly
    //     with a shimmer + caption. The still-running download promise then
    //     updates the row + emits `message:media:ready` when bytes land,
    //     swapping the shimmer for the image.
    // Failures in either path delete `evt.media` so the row is created (or
    // patched) as text-only with the caption — visible, not stuck.
    const IN_BAND_BUDGET_MS = 500;
    const downloadPromise = this.downloadInboundMedia(teamId, events);
    const downloadDone = await Promise.race([
      downloadPromise.then(() => true as const),
      new Promise<false>((r) => setTimeout(() => r(false), IN_BAND_BUDGET_MS)),
    ]);

    try {
      await ingestEvents(teamId, "meta_cloud", events);
    } catch (err) {
      // Meta retries on any non-2xx. Map error classes to the response that
      // actually matches the intent:
      //   - Transient DB pressure (pool timeout / serialization) → 503 so
      //     Meta retries the same batch after backoff. Re-ingest is safe
      //     because every event is deduped on (teamId, provider, externalId).
      //   - Anything else (parse drift, invariant violations) → 200 with
      //     `dropped`. Meta retrying a permanently-bad payload forever
      //     drains both our and their resources; logging + swallowing here
      //     leaves the row dropped, recoverable by replaying the raw payload
      //     manually if it matters.
      const code =
        err instanceof Prisma.PrismaClientKnownRequestError ? err.code : null;
      const transient =
        code === "P2024" /* pool timeout */ ||
        code === "P1001" /* server unreachable */ ||
        code === "P1002" /* connection timeout */ ||
        code === "P1008" /* operation timeout */;
      if (transient) {
        this.logger.warn(
          `[${teamId}] transient ingest failure (${code}); asking Meta to retry`,
        );
        throw new ServiceUnavailableException("transient ingest failure");
      }
      this.logger.error(
        `[${teamId}] permanent ingest failure; dropping batch of ${events.length}`,
        err,
      );
      return { ok: true, ingested: 0, dropped: "ingest_failed" };
    }

    if (!downloadDone) {
      // Budget expired — let the in-flight download finish in background,
      // then patch the row + emit. Detached because the response should
      // return now (~500-700ms total) so the agent's UI updates immediately.
      void this.completePendingMedia(teamId, events, downloadPromise).catch(
        (err) =>
          this.logger.error(`[${teamId}] background media completion failed`, err),
      );
    }

    return { ok: true, ingested: events.length };
  }

  /**
   * Wait for the in-flight download to finish, then bring every still-
   * pending row up to date — set its media columns + emit
   * `message:media:ready`, or clear the placeholder if the download failed.
   * Only fires when the in-band budget expired; the happy-path race-winner
   * case never calls this.
   */
  private async completePendingMedia(
    teamId: string,
    events: NormalizedEvent[],
    downloadPromise: Promise<void>,
  ): Promise<void> {
    await downloadPromise;
    const candidates = events
      .filter(
        (e): e is Extract<NormalizedEvent, { kind: "message" }> =>
          e.kind === "message",
      )
      .filter((evt) => evt.media || this.hadMedia(evt));
    if (candidates.length === 0) return;

    // Bulk-load every candidate row in a single round-trip instead of one
    // findFirst per event — at a 4-image batch this saves ~3 DB RTTs and
    // turns the per-event loop into pure CPU + a single later updateMany.
    const externalIds = candidates.map((e) => e.externalId);
    const rows = await this.db.message.findMany({
      where: { teamId, externalId: { in: externalIds } },
      select: {
        id: true,
        externalId: true,
        conversationId: true,
        mediaUrl: true,
        mediaKind: true,
      },
    });
    const rowByExtId = new Map(rows.map((r) => [r.externalId, r]));

    for (const evt of candidates) {
      const row = rowByExtId.get(evt.externalId);
      if (!row) continue;

      if (evt.media?.storageKey && evt.media.storageUrl) {
        // Download succeeded after the race lost. Patch + emit. CAS on
        // `mediaUrl: null` so a duplicate completion (e.g. the race winner
        // already wrote) becomes a no-op without an orphan.
        if (row.mediaUrl) continue;
        const updated = await this.db.message.updateMany({
          where: { id: row.id, mediaUrl: null },
          data: {
            mediaKey: evt.media.storageKey,
            mediaUrl: evt.media.storageUrl,
            mediaSizeBytes: evt.media.sizeBytes ?? null,
            mediaMimeType: evt.media.mimeType,
          },
        });
        if (updated.count === 0) continue;
        await publish({
          type: "message.media_ready",
          teamId,
          conversationId: row.conversationId,
          messageId: row.id,
          media: {
            kind: evt.media.kind,
            url: `/api/media/${row.id}`,
            mimeType: evt.media.mimeType,
            sizeBytes: evt.media.sizeBytes ?? 0,
            ...(evt.body ? { caption: evt.body } : {}),
            ...(evt.media.filename ? { filename: evt.media.filename } : {}),
            ...(evt.media.durationMs != null ? { durationMs: evt.media.durationMs } : {}),
          },
        });
      } else if (row.mediaKind && !row.mediaUrl) {
        // Download failed and the row was committed in pending state. Strip
        // the media columns + emit empty `message:media:ready` so the
        // shimmer collapses to a text-only bubble (caption preserved).
        await this.db.message.update({
          where: { id: row.id },
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
        await publish({
          type: "message.media_ready",
          teamId,
          conversationId: row.conversationId,
          messageId: row.id,
        });
      }
    }
  }

  /**
   * Did the parser originally attach media to this event? Used to tell
   * apart "never had media" (nothing to patch) from "had media but the
   * download path deleted it on failure" (need to clear the placeholder).
   */
  private hadMedia(
    evt: Extract<NormalizedEvent, { kind: "message" }>,
  ): boolean {
    // `rawPayload` is Meta's verbatim webhook body. `messages[0].type` is
    // one of "text" | "image" | "video" | "audio" | "document" | "sticker"
    // when this event came from Meta. Any non-text type means the parser
    // originally produced an evt.media that may have since been deleted.
    const m = (evt.rawPayload as {
      entry?: { changes?: { value?: { messages?: { id?: string; type?: string }[] } }[] }[];
    }).entry?.[0]?.changes?.[0]?.value?.messages;
    const meta = m?.find((x) => x.id === evt.externalId);
    return !!meta && meta.type !== "text";
  }

  /**
   * Download every inbound media binary, mutate the event's `media` so
   * `storageKey` / `storageUrl` / `sizeBytes` are populated, and let
   * `ingestEvents` create the row with media columns already set. On any
   * failure (no send config, size cap, fetch error, upload error) we
   * `delete evt.media` so the row is created as text-only with the caption
   * — visible failure, not a stuck shimmer.
   */
  private async downloadInboundMedia(
    teamId: string,
    events: NormalizedEvent[],
  ): Promise<void> {
    const mediaEvents = events.filter(
      (e): e is Extract<NormalizedEvent, { kind: "message" }> =>
        e.kind === "message" && !!e.media && !e.media.storageKey,
    );
    if (mediaEvents.length === 0) return;

    // Idempotency: a Meta retry of an already-ingested batch shouldn't
    // re-download and re-upload. If the row already exists with a mediaUrl
    // we copy it onto the event so ingest skips the create via P2002, and
    // we save the Meta fetch + blob upload entirely.
    const externalIds = mediaEvents.map((e) => e.externalId);
    const existing = await this.db.message.findMany({
      where: { teamId, externalId: { in: externalIds } },
      select: {
        externalId: true,
        mediaKey: true,
        mediaUrl: true,
        mediaSizeBytes: true,
        mediaMimeType: true,
      },
    });
    const existingByExtId = new Map(existing.map((r) => [r.externalId, r]));
    const todo = mediaEvents.filter((evt) => {
      const row = existingByExtId.get(evt.externalId);
      if (row?.mediaUrl && evt.media) {
        evt.media.storageKey = row.mediaKey ?? undefined;
        evt.media.storageUrl = row.mediaUrl;
        if (row.mediaSizeBytes != null) evt.media.sizeBytes = row.mediaSizeBytes;
        if (row.mediaMimeType) evt.media.mimeType = row.mediaMimeType;
        return false;
      }
      return true;
    });
    if (todo.length === 0) return;

    let sendConfig;
    try {
      sendConfig = await getMetaSendConfig(teamId);
    } catch (err) {
      this.logger.warn(`[${teamId}] cannot download media — send config missing`, err);
      // No way to fetch any of them — drop media so each row is created as
      // text-only with the caption preserved.
      for (const evt of todo) delete evt.media;
      return;
    }

    const team = await this.db.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });

    // 4 in-flight covers network latency without piling RAM (each fetch
    // buffers the binary). For a 4-image batch this stays under ~3s end
    // to end even on a cold Meta connection — well inside Meta's retry
    // window.
    await runWithConcurrency(todo, 4, async (evt) => {
      if (!evt.media) return;
      try {
        // Bounded retry on transient fetch/upload errors. Meta's media
        // download endpoint occasionally returns a 500 / connection reset
        // even though the binary is fine; without retry, a single blip
        // permanently strands the media (the row commits text-only and
        // there's no second chance). Three attempts × ~250-1000ms back-off
        // keeps total wall-time well inside Meta's webhook retry window.
        const fetched = await retry(
          () => getMetaProvider().fetchMedia!(evt.media!.externalMediaId, sendConfig),
          { attempts: 3, baseMs: 250 },
        );
        const cap = MEDIA_SIZE_CAPS[evt.media.kind];
        if (fetched.bytes.length > cap) {
          this.logger.warn(
            `[${teamId}] dropping ${evt.media.kind} over cap (${fetched.bytes.length} > ${cap})`,
          );
          delete evt.media;
          return;
        }
        const saved = await retry(
          () =>
            blobStorage.upload({
              bytes: fetched.bytes,
              mimeType: fetched.mimeType,
              kind: evt.media!.kind,
              context: {
                teamId,
                teamSlug: team?.name,
                direction: "in",
                contactPhone: evt.contactPhone,
                contactName: evt.contactName ?? undefined,
                externalId: evt.externalId,
                originalFilename: evt.media!.filename ?? null,
              },
            }),
          { attempts: 3, baseMs: 250 },
        );
        evt.media.storageKey = saved.key;
        evt.media.storageUrl = saved.url;
        evt.media.sizeBytes = saved.sizeBytes;
        evt.media.mimeType = fetched.mimeType;
      } catch (err) {
        this.logger.error(
          `[${teamId}] media download failed for ${evt.externalId} after retries`,
          err,
        );
        delete evt.media;
      }
    });
  }
}

/**
 * Tiny bounded-retry helper. Used for transient Meta / UploadThing errors
 * inside the webhook handler — long enough to ride out a single blip,
 * short enough to stay inside Meta's ~10s webhook retry window.
 */
async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; baseMs: number },
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === opts.attempts - 1) break;
      const jitter = Math.random() * opts.baseMs * 0.25;
      await new Promise((r) => setTimeout(r, opts.baseMs * 2 ** i + jitter));
    }
  }
  throw lastErr;
}

function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const queue = [...items];
  const lanes = Math.min(concurrency, queue.length);
  const runners = Array.from({ length: lanes }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });
  await Promise.all(runners);
}
