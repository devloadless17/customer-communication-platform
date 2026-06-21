import { createHmac, timingSafeEqual } from "node:crypto";

import {
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Logger,
  OnModuleDestroy,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Request, Response } from "express";

import { runWithConcurrency } from "@/common/concurrency";
import { blobStorage } from "@/lib/blob-storage";
import { publish } from "@/lib/events/bus";
import { MEDIA_SIZE_CAPS } from "@/lib/media-storage";
import { extractVideoPosterFrame } from "@/lib/media-thumbnail";
import { getMetaProvider } from "@/lib/providers";
import { MediaTooLargeError } from "@/lib/providers/meta";
import { getMetaSendConfig, getMetaWebhookConfig } from "@/lib/providers/config";
import { ingestEvents, isTransientDbError } from "@/lib/providers/ingest";
import type { NormalizedEvent } from "@ccp/shared/providers/types";

/**
 * Per-event outcome of the inbound-media download. Kept OUT of the event
 * object on purpose: `evt.media` is the parser's view (what Meta said the
 * binary is), and any concurrent mutation of it races with `ingestEvents`
 * which reads `storageKey`/`storageUrl` synchronously inside its own
 * transaction. Storing outcomes in a separate Map breaks the reference so
 * the download path can keep writing while ingest reads its frozen input.
 */
type DownloadOutcome =
  | {
      ok: true;
      storageKey: string;
      storageUrl: string;
      sizeBytes: number;
      mimeType: string;
      thumbnailStorageKey?: string;
      thumbnailStorageUrl?: string;
    }
  // `retriable` tells `completePendingMedia` whether to clear the row to
  // text-only NOW (permanent failure — re-downloading can't help) or PARK it
  // in the media-pending state so the inbound-media sweeper re-attempts the
  // download over a longer horizon (transient failure — a Meta-CDN / blob blip
  // that the bytes, retained by Meta for ~30 days, would survive). Without this
  // split, a single transient blip stripped media permanently.
  | { ok: false; retriable: boolean };

import { DbService } from "../../db/db.service";
import { WebhookRateLimitGuard } from "../webhook-rate-limit.guard";

/**
 * Per-team Meta WhatsApp Cloud API webhook.
 *
 *   GET  /webhooks/meta/:teamId   → one-time subscription verify challenge
 *   POST /webhooks/meta/:teamId   → real events; HMAC over the raw body
 *
 * Fail-soft posture: malformed payloads still return 200 so Meta doesn't
 * retry-storm.
 *
 * Multi-tenancy: `teamId` in the path is a routing signal, NOT proof of
 * origin. The HMAC against the team's per-tenant `metaAppSecret` is the
 * actual authentication.
 */
@Controller("webhooks/meta")
@UseGuards(WebhookRateLimitGuard)
export class MetaWebhookController implements OnModuleDestroy {
  private readonly logger = new Logger(MetaWebhookController.name);
  // In-flight inbound-media completions. Tracked so a SIGTERM mid-download
  // doesn't abandon the row patch — an abandoned row stays media-pending and
  // the inbound-media sweeper later CLEARS it to text-only (the binary is lost;
  // Meta media URLs expire). Drained, bounded, in onModuleDestroy.
  private readonly inFlightMedia = new Set<Promise<void>>();

  constructor(private readonly db: DbService) {}

  /**
   * Drain in-flight inbound-media completions on shutdown so the in-flight
   * ones finish their Meta download + blob upload + row patch instead of being
   * abandoned (→ sweeper clears them → media lost). Bounded so a single stuck
   * download can't blow the shutdown budget; on timeout the sweeper is the
   * backstop (same as today, but we tried). Part of the sequential
   * OnModuleDestroy chain capped by main.ts's app.close() budget.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.inFlightMedia.size === 0) return;
    const DRAIN_TIMEOUT_MS = 15_000;
    this.logger.log(
      `draining ${this.inFlightMedia.size} in-flight inbound-media completion(s)`,
    );
    await Promise.race([
      Promise.allSettled([...this.inFlightMedia]),
      new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS).unref()),
    ]);
  }

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
    // Timing-safe compare on the verify token + a length sanity cap on the
    // echoed challenge. Meta's challenge values are short opaque strings (~32
    // chars); refusing >255 chars stops a misrouted client from coaxing us
    // into echoing arbitrary text.
    if (
      mode === "subscribe" &&
      typeof token === "string" &&
      typeof challenge === "string" &&
      challenge.length > 0 &&
      challenge.length <= 255 &&
      timingSafeEqualString(token, config.verifyToken)
    ) {
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
      // Fail SOFT — Meta retries on any non-2xx and a 500 here would put
      // us in an infinite retry storm if a future middleware reordering
      // or content-type drift breaks the verify hook. Log loudly so the
      // regression is discoverable, but return 200 to bound the damage.
      this.logger.error(
        `[${teamId}] missing rawBody — main.ts verify hook regressed? returning 200 to avoid retry storm`,
      );
      return { ok: true, ingested: 0, dropped: "missing_raw_body" };
    }
    if (!verifySignature(rawBody, signature, config.appSecret)) {
      throw new HttpException("forbidden", 403);
    }

    // Body is already parsed by main.ts's bodyParser.json — req.body has it.
    const payload = req.body as unknown;

    // Defense-in-depth: HMAC against the per-team appSecret is the primary
    // authentication, but every legitimate Meta webhook also carries the
    // team's `phone_number_id` in metadata. A mismatch means either:
    //   (a) the appSecret was somehow accepted for a payload signed by a
    //       different team (would imply a Meta-side bug or our team-id
    //       routing being attacker-controlled), or
    //   (b) a misconfigured webhook subscription on Meta's side is
    //       pointing at the wrong team's URL.
    // Both warrant dropping the batch rather than ingesting messages
    // attributed to the wrong tenant. We only check if `metaPhoneNumberId`
    // is configured for the team — newly-onboarded teams that haven't
    // wired the field yet still receive events (the appSecret check is
    // the gate, and Meta won't sign anything to a non-onboarded team).
    if (phoneNumberMismatch(config.phoneNumberId, payload)) {
      this.logger.warn(
        `[${teamId}] webhook payload phone_number_id does not match team configuration — dropping`,
      );
      return { ok: true, ingested: 0, dropped: "phone_number_id_mismatch" };
    }

    // Fail SOFT — `parseWebhook` iterates Meta's array fields, and a future
    // Meta shape where one of those fields arrives as a non-array would make
    // the walk throw a TypeError on an HMAC-valid body. A 500 here puts us in
    // an infinite per-team retry storm (Meta retries any non-2xx). Log loudly,
    // drop the batch, and return 200 to bound the damage.
    let events: NormalizedEvent[];
    try {
      events = getMetaProvider().parseWebhook(payload);
    } catch (err) {
      this.logger.error(`[${teamId}] webhook parse failed; dropping batch`, err);
      return { ok: true, ingested: 0, dropped: "parse_failed" };
    }
    if (events.length === 0) return { ok: true, ingested: 0 };

    // Fully-async media flow. Kick off binary downloads in background and
    // commit the rows immediately as `mediaPending`. The bubble appears in
    // the agent's inbox in <100ms with a shimmer; `completePendingMedia`
    // patches the row + emits `message:media_ready` once bytes land,
    // swapping the shimmer for the image.
    //
    // Earlier versions raced the download against a 500ms in-band budget so
    // the happy path could ingest with media columns populated and save one
    // UPDATE. The race added a hard 500ms floor on every media-bearing
    // webhook (and made text bubbles in mixed batches wait too) — the floor
    // is the wrong tradeoff for "instant" perceived UX. Cost is now one
    // extra UPDATE per inbound media row; benefit is sub-100ms bubble paint
    // for every inbound, mirroring WhatsApp Web behavior.
    //
    // Outcomes live in `downloadOutcomes` (NOT on `evt.media`). The download
    // task writes outcomes as each event completes; `completePendingMedia`
    // reads the map after `downloadPromise` settles.
    const downloadOutcomes = new Map<string, DownloadOutcome>();
    const downloadPromise = this.downloadInboundMedia(teamId, events, downloadOutcomes);

    try {
      await ingestEvents(teamId, "whatsapp", events);
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
      if (isTransientDbError(err)) {
        const code =
          err instanceof Prisma.PrismaClientKnownRequestError ? err.code : "init";
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

    // Background-only: every media-bearing event waits for downloadPromise
    // then patches + emits. No-op when the batch has no media (the helper
    // filters internally). Tracked in `inFlightMedia` so onModuleDestroy can
    // drain it on shutdown rather than letting a SIGTERM abandon the patch.
    const completion = this.completePendingMedia(
      teamId,
      events,
      downloadPromise,
      downloadOutcomes,
    ).catch((err) =>
      this.logger.error(`[${teamId}] background media completion failed`, err),
    );
    this.inFlightMedia.add(completion);
    void completion.finally(() => this.inFlightMedia.delete(completion));

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
    outcomes: Map<string, DownloadOutcome>,
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
      const outcome = outcomes.get(evt.externalId);

      if (outcome?.ok && evt.media) {
        // Download succeeded after the race lost. Patch + emit. CAS on
        // BOTH `mediaUrl: null` AND `mediaKind: { not: null }`:
        //   - `mediaUrl: null` keeps the duplicate-completion path a no-op
        //     (e.g. the race winner already wrote, or a Meta retry's clone
        //     finished first).
        //   - `mediaKind: { not: null }` defends against the sweeper having
        //     already cleared this row's pending-media state. Without it,
        //     a slow video download (≥ 2min wall clock) that lands AFTER
        //     the inbound-media sweeper has nulled mediaKind would resurrect
        //     mediaUrl + mediaKey on a row whose mediaKind is null — the
        //     bubble renders with no kind metadata.
        if (row.mediaUrl || !row.mediaKind) continue;
        const updated = await this.db.message.updateMany({
          where: { id: row.id, mediaUrl: null, mediaKind: { not: null } },
          data: {
            mediaKey: outcome.storageKey,
            mediaUrl: outcome.storageUrl,
            mediaSizeBytes: outcome.sizeBytes,
            mediaMimeType: outcome.mimeType,
            ...(outcome.thumbnailStorageKey && outcome.thumbnailStorageUrl
              ? {
                  mediaThumbnailKey: outcome.thumbnailStorageKey,
                  mediaThumbnailUrl: outcome.thumbnailStorageUrl,
                }
              : {}),
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
            mimeType: outcome.mimeType,
            sizeBytes: outcome.sizeBytes,
            ...(evt.body ? { caption: evt.body } : {}),
            ...(evt.media.filename ? { filename: evt.media.filename } : {}),
            ...(evt.media.durationMs != null ? { durationMs: evt.media.durationMs } : {}),
            // Carry the WhatsApp push-to-talk flag so the just-arrived voice note
            // renders with the mic glyph + waveform LIVE — applyMessageMediaReady
            // replaces `media` wholesale, so a voice-less frame would otherwise
            // overwrite the placeholder's voice:true and the bubble would read as
            // a generic audio file until the next SSR/refetch.
            ...(evt.media.voice ? { voice: true } : {}),
            ...(outcome.thumbnailStorageUrl
              ? { thumbnailUrl: `/api/media/${row.id}/thumb` }
              : {}),
          },
        });
      } else if (outcome && !outcome.ok && outcome.retriable) {
        // Transient download failure — PARK the row in its media-pending state
        // (mediaKind set, mediaUrl null) instead of clearing. The inbound-media
        // sweeper re-attempts the download from the Meta media id in rawPayload
        // over its 24h horizon before any final text-only downgrade. Leaving
        // the bubble as a shimmer is the correct signal: the media is still
        // being fetched, not lost.
        continue;
      } else if (
        (outcome && !outcome.ok && !outcome.retriable) ||
        (!outcome && row.mediaKind && !row.mediaUrl)
      ) {
        // Permanent download failure (over cap / no send config) OR no outcome
        // ever arrived and the row is stuck in media-pending state. Strip the
        // media columns + emit empty `message:media:ready` so the shimmer
        // collapses to a text-only bubble (caption preserved). CAS on
        // `mediaKind: { not: null }` so a duplicate completion path
        // (concurrent Meta retry that also failed) becomes a no-op instead
        // of re-emitting the clear event to every connected agent.
        if (!row.mediaKind || row.mediaUrl) continue;
        const cleared = await this.db.message.updateMany({
          where: { id: row.id, mediaKind: { not: null }, mediaUrl: null },
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
        if (cleared.count === 0) continue;
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
   * Return true iff the payload's `entry[*].changes[*].value.metadata
   * .phone_number_id` does NOT match the team's stored metaPhoneNumberId.
   *
   * Returns false (= "match, proceed") when:
   *   - The team has no `metaPhoneNumberId` configured (fresh onboarding).
   *   - The payload omits metadata (some Meta event types, e.g. some
   *     account-update webhooks, don't carry it — we can't filter and
   *     leave them as the appSecret-only check).
   *   - Every change's phone_number_id matches the team's.
   *
   * Only iterates the shape we care about — a malformed payload (no entry
   * array) returns false rather than crashing the request.
   */
  // (Free function below — moved out of the controller class so it can read
  // the cached `phoneNumberId` from getMetaWebhookConfig instead of a per-
  // request `db.team.findUnique`.)

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
   * Download every inbound media binary and write the outcome to the shared
   * `outcomes` Map keyed by `evt.externalId`. CRITICALLY: this does NOT
   * mutate `evt.media` — see the DownloadOutcome doc above and the race
   * fence in `handlePost` for why. `ingestEvents` reads `evt.media`
   * synchronously inside its transaction; concurrent in-place mutation
   * here used to interleave with that read, producing torn rows (storageKey
   * set but storageUrl null, etc.).
   *
   * On any failure (no send config, size cap, fetch error, upload error)
   * we set `outcomes.set(id, { ok: false })` so the row commits text-only
   * with the caption — visible failure, not a stuck shimmer.
   */
  private async downloadInboundMedia(
    teamId: string,
    events: NormalizedEvent[],
    outcomes: Map<string, DownloadOutcome>,
  ): Promise<void> {
    const mediaEvents = events.filter(
      (e): e is Extract<NormalizedEvent, { kind: "message" }> =>
        e.kind === "message" && !!e.media && !e.media.storageKey,
    );
    if (mediaEvents.length === 0) return;

    // Idempotency: a Meta retry of an already-ingested batch shouldn't
    // re-download and re-upload. If the row already exists with a mediaUrl
    // we record it as a successful outcome so ingest skips the create via
    // P2002 and we save the Meta fetch + blob upload entirely.
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
        outcomes.set(evt.externalId, {
          ok: true,
          storageKey: row.mediaKey ?? "",
          storageUrl: row.mediaUrl,
          sizeBytes: row.mediaSizeBytes ?? 0,
          mimeType: row.mediaMimeType ?? evt.media.mimeType,
        });
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
      // No way to fetch any of them — record failure so each row is created
      // as text-only with the caption preserved. Non-retriable: a missing send
      // config is a structural/config issue, not a transient blip — parking
      // these would just leave a shimmer the sweeper can never resolve either.
      for (const evt of todo) outcomes.set(evt.externalId, { ok: false, retriable: false });
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
      const mediaKind = evt.media.kind;
      try {
        // Bounded retry on transient fetch/upload errors. Meta's media
        // download endpoint occasionally returns a 500 / connection reset
        // even though the binary is fine; without retry, a single blip
        // permanently strands the media (the row commits text-only and
        // there's no second chance). Three attempts × ~250-1000ms back-off
        // keeps total wall-time well inside Meta's webhook retry window.
        const cap = MEDIA_SIZE_CAPS[mediaKind];
        // minor#3: hand the per-kind cap to fetchMedia so it can reject via
        // Content-Length BEFORE buffering the binary into heap (RAM guard for a
        // 4-wide batch of large docs). The post-buffer check below stays as the
        // authoritative cap for the case where the CDN omits/understates the
        // header.
        const fetched = await retry(
          () =>
            getMetaProvider().fetchMedia!(evt.media!.externalMediaId, sendConfig, cap),
          { attempts: 3, baseMs: 250 },
        );
        if (fetched.bytes.length > cap) {
          this.logger.warn(
            `[${teamId}] dropping ${mediaKind} over cap (${fetched.bytes.length} > ${cap})`,
          );
          // Deterministic: re-downloading yields the same over-cap bytes.
          outcomes.set(evt.externalId, { ok: false, retriable: false });
          return;
        }
        const saved = await retry(
          () =>
            blobStorage.upload({
              bytes: fetched.bytes,
              mimeType: fetched.mimeType,
              kind: mediaKind,
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

        let thumbnailStorageKey: string | undefined;
        let thumbnailStorageUrl: string | undefined;
        // Video-only: generate + upload a poster frame so the bubble doesn't
        // render as a black rectangle until the user clicks play. Best-effort;
        // an ffmpeg failure or corrupt video leaves thumbnail* fields null
        // and the VideoBlock falls back to bg-black (same end-state as
        // before M8 landed). Bounded at ~10s of ffmpeg wall-clock.
        if (mediaKind === "video") {
          try {
            const poster = await extractVideoPosterFrame(fetched.bytes);
            if (poster && poster.length > 0) {
              const thumb = await retry(
                () =>
                  blobStorage.upload({
                    bytes: poster,
                    mimeType: "image/jpeg",
                    kind: "image",
                    context: {
                      teamId,
                      teamSlug: team?.name,
                      direction: "in",
                      contactPhone: evt.contactPhone,
                      contactName: evt.contactName ?? undefined,
                      // Suffix the wamid so the dashboard filename is
                      // distinct from the original video's blob.
                      externalId: `${evt.externalId}_thumb`,
                      originalFilename: null,
                    },
                  }),
                { attempts: 2, baseMs: 250 },
              );
              thumbnailStorageKey = thumb.key;
              thumbnailStorageUrl = thumb.url;
            }
          } catch (err) {
            this.logger.warn(
              `[${teamId}] video poster generation failed for ${evt.externalId}: ${err instanceof Error ? err.message : err}`,
            );
            // Swallow — the video itself is fine; the bubble just won't
            // have a poster. Strictly better than failing the whole ingest.
          }
        }

        // Commit the successful outcome AFTER every async step is done.
        // Single atomic Map.set per event — no torn state possible because
        // the caller reads the value, not individual fields.
        outcomes.set(evt.externalId, {
          ok: true,
          storageKey: saved.key,
          storageUrl: saved.url,
          sizeBytes: saved.sizeBytes,
          mimeType: fetched.mimeType,
          ...(thumbnailStorageKey && thumbnailStorageUrl
            ? { thumbnailStorageKey, thumbnailStorageUrl }
            : {}),
        });
      } catch (err) {
        // minor#3: an over-cap file (rejected pre-buffer via Content-Length) is
        // a DETERMINISTIC failure — re-downloading yields the same over-cap
        // bytes — so drop it non-retriably, exactly like the post-buffer cap
        // check above. Parking it for the sweeper would loop forever.
        if (err instanceof MediaTooLargeError) {
          this.logger.warn(
            `[${teamId}] dropping ${mediaKind} over cap before download (${err.declaredBytes} > ${err.maxBytes})`,
          );
          outcomes.set(evt.externalId, { ok: false, retriable: false });
          return;
        }
        this.logger.error(
          `[${teamId}] media download failed for ${evt.externalId} after retries`,
          err,
        );
        // Transient (Meta-CDN / blob blip survived the in-request retry) —
        // park the row so the inbound-media sweeper re-attempts over its
        // longer horizon instead of losing the media permanently. Meta retains
        // the binary ~30 days, so the media id in rawPayload stays fetchable.
        outcomes.set(evt.externalId, { ok: false, retriable: true });
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

/**
 * Phone-number-id defense-in-depth check. Returns true if the payload's
 * `entry[].changes[].value.metadata.phone_number_id` is set on at least
 * one change AND doesn't match the team-configured number. False when:
 *   - The team has no `phoneNumberId` configured (newly onboarded; HMAC
 *     is the only gate).
 *   - The payload omits metadata on every change (some Meta event types
 *     don't carry it).
 *   - Every change's phone_number_id matches.
 *
 * Reads from the cached `MetaWebhookConfig.phoneNumberId` instead of a
 * per-request DB lookup — see provider/config.ts for the cache TTL.
 */
function phoneNumberMismatch(
  expected: string | null,
  payload: unknown,
): boolean {
  if (!expected) return false;
  const p = payload as {
    entry?: Array<{
      changes?: Array<{
        value?: { metadata?: { phone_number_id?: string } };
      }>;
    }>;
  };
  const entries = p?.entry;
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    const changes = entry?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const incoming = change?.value?.metadata?.phone_number_id;
      if (incoming && incoming !== expected) return true;
    }
  }
  return false;
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

/**
 * Constant-time string compare. Used by the verify-token handshake so a
 * remote prober can't time-difference the prefix of the expected token.
 * Both inputs are coerced to fixed-length Buffers; the length-mismatch
 * branch is a precondition of `timingSafeEqual` (which throws on unequal
 * lengths) — comparing a zero-padded buffer instead would just hide the
 * length leak without preventing it.
 */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
