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
import { reconcileInboundMediaMime } from "@/lib/blob-storage/mime-guard";
import { publish } from "@/lib/events/bus";
import { MEDIA_SIZE_CAPS, mediaPolicyForChannel } from "@/lib/media-storage";
import {
  extractImageThumbnail,
  extractVideoPosterFrame,
  probeMediaDurationMs,
} from "@/lib/media-thumbnail";
import { getMetaProvider } from "@/lib/providers";
import { MediaTooLargeError } from "@/lib/providers/meta";
import { metaWireEnabled, wireIn } from "@/lib/providers/meta-wire";
import {
  getMetaSendConfig,
  getMetaWebhookConfig,
  getTeamVerifyTokens,
} from "@/lib/providers/config";
import { messengerProvider } from "@/lib/providers/messenger";
import { getMessengerWebhookConfig } from "@/lib/providers/messenger-config";
import { instagramProvider } from "@/lib/providers/instagram";
import { getInstagramWebhookConfig } from "@/lib/providers/instagram-config";
import {
  enrichSocialContactNames,
  ingestEvents,
  isTransientDbError,
} from "@/lib/providers/ingest";
import { enqueueHistoryChunk } from "@/lib/coexistence/history-queue";
import type { NormalizedEvent } from "@ccp/shared/providers/types";
import type { Channel, MediaKind } from "@ccp/shared/types";
import { mediaPreviewLabel } from "@ccp/shared/types";

/**
 * Which channel a Meta webhook envelope belongs to, from its `object` field.
 * Meta delivers all products to the same callback, so one endpoint fans out by
 * `object`. Reading this from the (untrusted) body to select which channel's
 * app-secret verifies the HMAC is safe: an attacker can flip `object` but still
 * can't forge a valid signature without the secret. `instagram` is added when
 * its provider ships.
 */
function channelForMetaObject(
  payload: unknown,
): "whatsapp" | "messenger" | "instagram" | null {
  if (typeof payload !== "object" || payload === null) return null;
  switch ((payload as { object?: unknown }).object) {
    case "whatsapp_business_account":
      return "whatsapp";
    case "page":
      return "messenger";
    case "instagram":
      return "instagram";
    default:
      return null;
  }
}

/** The provider + webhook-config loader for a social (non-WhatsApp) channel. */
const SOCIAL = {
  messenger: { provider: messengerProvider, getWebhookConfig: getMessengerWebhookConfig },
  instagram: { provider: instagramProvider, getWebhookConfig: getInstagramWebhookConfig },
} as const;

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
      // Probed from the bytes for inbound audio/voice (the WhatsApp webhook
      // carries no duration) so the bubble shows the length up front like real
      // WhatsApp. Undefined for other kinds / when the probe fails.
      durationMs?: number;
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
    // The one callback verifies every Meta product the team connected, so
    // accept the challenge if the token matches ANY of the team's channel
    // verify tokens. We can't know the channel from a verify GET (it carries
    // only mode/token/challenge), so check each. Read the raw tokens — NOT the
    // full webhook config — so a callback can be verified in Meta before the
    // connection is fully wired (Meta's natural setup order: verify first, add
    // the app secret + send credentials after). The POST path independently
    // requires the app secret, so honoring a token here grants no access.
    const verifyTokens = await getTeamVerifyTokens(teamId);
    if (verifyTokens.length === 0) {
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
      verifyTokens.some((vt) => timingSafeEqualString(token, vt))
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
    // Fan out by the webhook `object` (Meta delivers all products to one
    // callback). Messenger has its own isolated path; anything unsupported
    // (e.g. a future `instagram` object before its provider ships) is dropped
    // softly so Meta doesn't retry-storm. WhatsApp falls through to the
    // existing, byte-identical path below.
    const channel = channelForMetaObject(req.body);
    if (channel === "messenger" || channel === "instagram") {
      return this.receiveSocial(teamId, signature, req, channel);
    }
    if (channel !== "whatsapp") {
      return { ok: true, ingested: 0, dropped: "unsupported_object" };
    }

    const config = await getMetaWebhookConfig(teamId);
    if (!config) throw webhookForbidden(this.logger, teamId, "whatsapp", req, "no_config");

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
    if (!insecureSkipVerify(this.logger)) {
      if (!signature) throw webhookForbidden(this.logger, teamId, "whatsapp", req, "no_signature");
      const cands = [config.appSecret, config.appSecretFallback];
      if (!verifySignature(rawBody, signature, cands)) {
        logSignatureDiag(this.logger, signature, rawBody, cands);
        throw webhookForbidden(this.logger, teamId, "whatsapp", req, "bad_signature");
      }
    }

    // Dev wire log (DEBUG_META_WIRE): the authentic raw webhook, so you can see
    // EXACTLY what Meta sent. After verify so we never log a forged body.
    wireIn(channel, rawBody.toString("utf8"));

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

    // WhatsApp Coexistence history backfill. The `history` webhook can carry
    // thousands of past messages across chunked deliveries — far too much to
    // ingest inline within the fail-soft budget. Detect it, hand the RAW payload
    // to the coexistence-history BullMQ worker, and 200 immediately. The worker
    // re-parses + ingests quietly (no unread bump / no automation fanout). Live
    // message/echo/state-sync webhooks fall through to the fast inline path
    // below. A history webhook is its own delivery (Meta doesn't mix history
    // with live messages), so treating any history-bearing payload as a backfill
    // chunk is safe.
    if (containsHistory(payload)) {
      try {
        await enqueueHistoryChunk(teamId, payload);
        return { ok: true, ingested: 0 };
      } catch (err) {
        // Redis down / enqueue failed → 503 so Meta redelivers the chunk (the
        // worker dedups by wamid, so a redelivery is safe). Better than dropping
        // history the customer can never re-fetch.
        this.logger.error(`[${teamId}] failed to enqueue history chunk`, err);
        throw new ServiceUnavailableException("history enqueue failed");
      }
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
    // The ingest-failure branches below return/throw WITHOUT ever consuming
    // `downloadPromise` (only the success path threads it into
    // `completePendingMedia`). A rejection on that orphaned promise would
    // surface as an unhandledRejection. Attach a non-consuming handler so it
    // can never float — the original promise is unchanged, so the success
    // path's `await downloadPromise` still observes the real settlement.
    downloadPromise.catch((err) =>
      this.logger.error(`[${teamId}] inbound media download failed`, err),
    );

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
        // Label the actual cause: driver-level faults (pool exhaustion, socket
        // resets) are neither a Prisma error code nor an init error, and calling
        // them "init" sent incident triage down the wrong path.
        const code =
          err instanceof Prisma.PrismaClientKnownRequestError
            ? err.code
            : err instanceof Prisma.PrismaClientInitializationError
              ? "init"
              : `driver:${String((err as { code?: unknown })?.code ?? "timeout")}`;
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
   * Meta SOCIAL inbound path (Messenger `object:"page"` / Instagram
   * `object:"instagram"`). Same HMAC + fail-soft posture as the WhatsApp path,
   * but simpler: no phone-number mismatch guard, no Coexistence history, and
   * (this increment) no inbound media download — text + delivery status only.
   * Everything below the parser (`ingestEvents`) is channel-generic, so a
   * social contact/conversation/message flows through the exact same pipeline
   * as WhatsApp.
   */
  private async receiveSocial(
    teamId: string,
    signature: string | undefined,
    req: Request,
    channel: "messenger" | "instagram",
  ): Promise<{ ok: boolean; ingested?: number; dropped?: string }> {
    const { provider, getWebhookConfig } = SOCIAL[channel];
    const config = await getWebhookConfig(teamId);
    if (!config) throw webhookForbidden(this.logger, teamId, channel, req, "no_config");

    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      this.logger.error(
        `[${teamId}] ${channel} webhook missing rawBody — returning 200 to avoid retry storm`,
      );
      return { ok: true, ingested: 0, dropped: "missing_raw_body" };
    }
    if (!insecureSkipVerify(this.logger)) {
      if (!signature) throw webhookForbidden(this.logger, teamId, channel, req, "no_signature");
      const cands = [config.appSecret, config.appSecretFallback];
      if (!verifySignature(rawBody, signature, cands)) {
        logSignatureDiag(this.logger, signature, rawBody, cands);
        throw webhookForbidden(this.logger, teamId, channel, req, "bad_signature");
      }
    }

    // Dev wire log (DEBUG_META_WIRE): the authentic raw social webhook.
    wireIn(channel, rawBody.toString("utf8"));

    const payload = req.body as unknown;

    // Defense-in-depth: the webhook's `entry[].id` must match the team's
    // configured business account (Page id for Messenger, IG account id for
    // Instagram). Parity with WhatsApp's phone_number_id mismatch guard.
    const cfgIds = config as { pageId?: string | null; igId?: string | null };
    const expectedEntryId =
      (channel === "messenger" ? cfgIds.pageId : cfgIds.igId) ?? null;
    if (socialEntryIdMismatch(expectedEntryId, payload)) {
      this.logger.warn(
        `[${teamId}] ${channel} webhook entry.id does not match team configuration — dropping`,
      );
      return { ok: true, ingested: 0, dropped: "entry_id_mismatch" };
    }

    let events: NormalizedEvent[];
    try {
      events = provider.parseWebhook(payload);
    } catch (err) {
      this.logger.error(`[${teamId}] ${channel} webhook parse failed; dropping batch`, err);
      return { ok: true, ingested: 0, dropped: "parse_failed" };
    }
    if (events.length === 0) return { ok: true, ingested: 0 };

    // Kick off social media downloads (direct CDN URL → R2) concurrently with
    // ingest, which commits the rows as media-pending. Non-consuming catch so
    // an orphaned rejection can't float if ingest below fails and returns early;
    // completePendingMedia awaits the same promise on the success path.
    const downloadOutcomes = new Map<string, DownloadOutcome>();
    const downloadPromise = this.downloadSocialMedia(
      teamId,
      channel,
      events,
      downloadOutcomes,
    );
    downloadPromise.catch((err) =>
      this.logger.error(`[${teamId}] ${channel} media download failed`, err),
    );

    try {
      await ingestEvents(teamId, channel, events);
    } catch (err) {
      // Same transient-vs-permanent split as WhatsApp: 503 → Meta retries the
      // (deduped) batch on transient DB pressure; 200-dropped otherwise so a
      // permanently-bad payload doesn't retry-storm.
      if (isTransientDbError(err)) {
        throw new ServiceUnavailableException("transient ingest failure");
      }
      this.logger.error(
        `[${teamId}] permanent ${channel} ingest failure; dropping batch of ${events.length}`,
        err,
      );
      return { ok: true, ingested: 0, dropped: "ingest_failed" };
    }

    // Detached: give brand-new social contacts a real display name (the webhook
    // carries none, so ingest named them by their opaque id). Never blocks the
    // 200; fail-soft. Non-consuming catch so the fire-and-forget can't float.
    const senderIds = events.flatMap((e) =>
      e.kind === "message" && e.externalContactId ? [e.externalContactId] : [],
    );
    if (senderIds.length > 0) {
      void enrichSocialContactNames(teamId, channel, senderIds).catch((err) =>
        this.logger.error(`[${teamId}] ${channel} name enrichment failed`, err),
      );
    }

    // Background: await the media downloads, then patch the rows + emit
    // message:media:ready (or collapse the shimmer to a labeled bubble on
    // failure). Tracked in inFlightMedia so onModuleDestroy drains it on
    // shutdown rather than abandoning a half-written patch.
    const completion = this.completePendingMedia(
      teamId,
      events,
      downloadPromise,
      downloadOutcomes,
      channel,
    ).catch((err) =>
      this.logger.error(`[${teamId}] ${channel} media completion failed`, err),
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
    channel: Channel = "whatsapp",
  ): Promise<void> {
    await downloadPromise;
    const candidates = events
      .filter(
        (e): e is Extract<NormalizedEvent, { kind: "message" | "echo" }> =>
          // Include Coexistence echoes: a photo the owner sent from the phone
          // app needs the same fetch → patch → media_ready flow as inbound media.
          e.kind === "message" || e.kind === "echo",
      )
      .filter((evt) => evt.media || this.hadMedia(evt));
    if (candidates.length === 0) return;

    // Bulk-load every candidate row in a single round-trip instead of one
    // findFirst per event — at a 4-image batch this saves ~3 DB RTTs and
    // turns the per-event loop into pure CPU + a single later updateMany.
    const externalIds = candidates.map((e) => e.externalId);
    const rows = await this.db.message.findMany({
      where: { teamId, channel, externalId: { in: externalIds } },
      select: {
        id: true,
        externalId: true,
        conversationId: true,
        mediaUrl: true,
        mediaKind: true,
        body: true,
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
        // Prefer a duration probed from the bytes (inbound audio has none on the
        // webhook) over whatever the event carried.
        const durationMs = outcome.durationMs ?? evt.media.durationMs ?? null;
        const updated = await this.db.message.updateMany({
          where: { id: row.id, mediaUrl: null, mediaKind: { not: null } },
          data: {
            mediaKey: outcome.storageKey,
            mediaUrl: outcome.storageUrl,
            mediaSizeBytes: outcome.sizeBytes,
            mediaMimeType: outcome.mimeType,
            ...(durationMs != null ? { mediaDurationMs: durationMs } : {}),
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
            ...(durationMs != null ? { durationMs } : {}),
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
        // When the row would otherwise collapse to an EMPTY bubble (no caption),
        // stamp a kind label ("🌟 Sticker" / "🎤 Voice message" / …) so a media we
        // couldn't download reads as what it was, not a bare "Attachment
        // unavailable". Only when the body is empty — a caption is preserved.
        const fallbackBody =
          row.body && row.body.length > 0
            ? undefined
            : mediaPreviewLabel(row.mediaKind as MediaKind);
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
            ...(fallbackBody ? { body: fallbackBody } : {}),
          },
        });
        if (cleared.count === 0) continue;
        await publish({
          type: "message.media_ready",
          teamId,
          conversationId: row.conversationId,
          messageId: row.id,
          // No media (download failed) — the reducer strips the media block. The
          // fallback label lands on the row via `body` above; it shows on the next
          // fetch/reload (the media_ready frame carries no body).
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
    evt: Extract<NormalizedEvent, { kind: "message" | "echo" }>,
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
   * Download inbound SOCIAL media (Messenger / Instagram). Unlike WhatsApp —
   * which fetches by media-id using the send config — social attachments arrive
   * as a direct, expiring CDN URL (`evt.media.sourceUrl`), so we GET the URL,
   * size-cap it, and stream it to R2. Same outcomes-Map contract as
   * `downloadInboundMedia` (never mutates `evt.media`; records `{ok:false}` on
   * failure so the row commits as a labeled bubble, not a stuck shimmer). No
   * WhatsApp send-config needed, so a social-only team downloads media fine.
   */
  private async downloadSocialMedia(
    teamId: string,
    channel: Channel,
    events: NormalizedEvent[],
    outcomes: Map<string, DownloadOutcome>,
  ): Promise<void> {
    const mediaEvents = events.filter(
      (e): e is Extract<NormalizedEvent, { kind: "message" | "echo" }> =>
        (e.kind === "message" || e.kind === "echo") &&
        !!e.media?.sourceUrl &&
        !e.media.storageKey,
    );
    if (mediaEvents.length === 0) return;

    // Idempotency: a Meta retry of an already-ingested batch shouldn't
    // re-download. An existing row with a mediaUrl → record success + skip.
    const externalIds = mediaEvents.map((e) => e.externalId);
    const existing = await this.db.message.findMany({
      where: { teamId, channel, externalId: { in: externalIds } },
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

    const team = await this.db.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });

    await runWithConcurrency(todo, 4, async (evt) => {
      const media = evt.media;
      if (!media?.sourceUrl) return;
      const mediaKind = media.kind;
      // A native-inbox echo (business sent it from Meta's app) is OUTBOUND and
      // carries no contactName; an inbound message is the inverse.
      const isEcho = evt.kind === "echo";
      const blobDirection: "in" | "out" = isEcho ? "out" : "in";
      const blobContactName =
        evt.kind === "message" ? evt.contactName ?? undefined : undefined;
      // Channel-aware cap — Messenger/Instagram deliver larger media than
      // WhatsApp's caps allow, so use the per-channel policy here too.
      const cap = mediaPolicyForChannel(channel).caps[mediaKind];
      try {
        // Same process-wide download slot as the WhatsApp path — a parallel
        // burst of social attachments (25MB each) buffers just as much RAM.
        const fetched = await withMediaDownloadSlot(() =>
          retry(() => fetchUrlBytes(media.sourceUrl!, cap), {
            attempts: 3,
            baseMs: 250,
          }),
        );
        if (fetched.bytes.length > cap) {
          this.logger.warn(
            `[${teamId}] dropping social ${mediaKind} over cap (${fetched.bytes.length} > ${cap})`,
          );
          outcomes.set(evt.externalId, { ok: false, retriable: false });
          return;
        }
        // Meta's social CDN mislabels voice notes (m4a/aac = MP4 container) as
        // `video/mp4`; reconcile against the trusted kind so audio isn't dropped.
        const storeMime = reconcileInboundMediaMime(mediaKind, fetched.mimeType, fetched.bytes);
        const saved = await retry(
          () =>
            blobStorage.upload({
              bytes: fetched.bytes,
              mimeType: storeMime,
              kind: mediaKind,
              context: {
                teamId,
                teamSlug: team?.name,
                direction: blobDirection,
                // Social has no phone; use the opaque id for the dashboard name.
                contactPhone: evt.externalContactId,
                contactName: blobContactName,
                externalId: evt.externalId,
                originalFilename: media.filename ?? null,
              },
            }),
          { attempts: 3, baseMs: 250 },
        );

        let thumbnailStorageKey: string | undefined;
        let thumbnailStorageUrl: string | undefined;
        if (mediaKind === "video" || mediaKind === "image") {
          try {
            // Video → poster frame; image → downscaled thumbnail. Both are
            // uploaded + served the same way (the bubble prefers the thumb, taps
            // through to the original).
            const poster =
              mediaKind === "video"
                ? await extractVideoPosterFrame(fetched.bytes)
                : await extractImageThumbnail(fetched.bytes);
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
                      direction: blobDirection,
                      contactPhone: evt.externalContactId,
                      contactName: blobContactName,
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
              `[${teamId}] social video poster failed for ${evt.externalId}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }

        let durationMs: number | undefined;
        if (mediaKind === "audio") {
          durationMs = (await probeMediaDurationMs(fetched.bytes)) ?? undefined;
        }

        outcomes.set(evt.externalId, {
          ok: true,
          storageKey: saved.key,
          storageUrl: saved.url,
          sizeBytes: saved.sizeBytes,
          mimeType: storeMime,
          ...(thumbnailStorageKey && thumbnailStorageUrl
            ? { thumbnailStorageKey, thumbnailStorageUrl }
            : {}),
          ...(durationMs != null ? { durationMs } : {}),
        });
      } catch (err) {
        this.logger.warn(
          `[${teamId}] social media download failed for ${evt.externalId}: ${err instanceof Error ? err.message : err}`,
        );
        // The inbound-media sweeper re-fetches by WhatsApp media-id, which social
        // has none of (and the CDN URL expires), so mark non-retriable — the row
        // commits as a labeled bubble rather than a shimmer the sweeper can't fix.
        outcomes.set(evt.externalId, { ok: false, retriable: false });
      }
    });
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
      (e): e is Extract<NormalizedEvent, { kind: "message" | "echo" }> =>
        (e.kind === "message" || e.kind === "echo") &&
        !!e.media &&
        !e.media.storageKey,
    );
    if (mediaEvents.length === 0) return;

    // Idempotency: a Meta retry of an already-ingested batch shouldn't
    // re-download and re-upload. If the row already exists with a mediaUrl
    // we record it as a successful outcome so ingest skips the create via
    // P2002 and we save the Meta fetch + blob upload entirely.
    const externalIds = mediaEvents.map((e) => e.externalId);
    const existing = await this.db.message.findMany({
      where: { teamId, channel: "whatsapp", externalId: { in: externalIds } },
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
      // Blob-storage context differs by source: inbound customer media vs. a
      // Coexistence echo (a photo the owner sent from the phone). Echoes carry
      // no contactName (the `to` is just a number), so read it only when present.
      const isEcho = evt.kind === "echo";
      const blobDirection: "in" | "out" = isEcho ? "out" : "in";
      const blobContactName = "contactName" in evt ? evt.contactName ?? undefined : undefined;
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
        // Hold a process-wide download slot for the fetch: the per-batch
        // runWithConcurrency(4) only bounds THIS webhook, but Meta fans
        // deliveries out in parallel across all tenants, so a redelivery burst
        // can put dozens of full binary Buffers in flight at once. The slot caps
        // the aggregate; a wait-timeout throws into the catch below → retriable
        // outcome → sweeper re-attempts. See withMediaDownloadSlot.
        const fetched = await withMediaDownloadSlot(() =>
          retry(
            () =>
              getMetaProvider().fetchMedia!(evt.media!.externalMediaId, sendConfig, cap),
            { attempts: 3, baseMs: 250 },
          ),
        );
        if (fetched.bytes.length > cap) {
          this.logger.warn(
            `[${teamId}] dropping ${mediaKind} over cap (${fetched.bytes.length} > ${cap})`,
          );
          // Deterministic: re-downloading yields the same over-cap bytes.
          outcomes.set(evt.externalId, { ok: false, retriable: false });
          return;
        }
        // Reconcile a CDN-mislabeled audio/video Content-Type against the trusted
        // kind (same voice-note guard as the social path — harmless here since
        // WhatsApp's media-node mime is usually accurate).
        const storeMime = reconcileInboundMediaMime(mediaKind, fetched.mimeType, fetched.bytes);
        const saved = await retry(
          () =>
            blobStorage.upload({
              bytes: fetched.bytes,
              mimeType: storeMime,
              kind: mediaKind,
              context: {
                teamId,
                teamSlug: team?.name,
                direction: blobDirection,
                contactPhone: evt.contactPhone,
                contactName: blobContactName,
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
        if (mediaKind === "video" || mediaKind === "image") {
          try {
            // Video → poster frame; image → downscaled thumbnail. Both are
            // uploaded + served the same way (the bubble prefers the thumb, taps
            // through to the original).
            const poster =
              mediaKind === "video"
                ? await extractVideoPosterFrame(fetched.bytes)
                : await extractImageThumbnail(fetched.bytes);
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
                      direction: blobDirection,
                      contactPhone: evt.contactPhone,
                      contactName: blobContactName,
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

        // Audio/voice: the WhatsApp webhook carries no duration, so probe it
        // from the bytes (best-effort) — real WhatsApp shows the length up front.
        let durationMs: number | undefined;
        if (mediaKind === "audio") {
          durationMs = (await probeMediaDurationMs(fetched.bytes)) ?? undefined;
        }

        // Commit the successful outcome AFTER every async step is done.
        // Single atomic Map.set per event — no torn state possible because
        // the caller reads the value, not individual fields.
        outcomes.set(evt.externalId, {
          ok: true,
          storageKey: saved.key,
          storageUrl: saved.url,
          sizeBytes: saved.sizeBytes,
          mimeType: storeMime,
          ...(thumbnailStorageKey && thumbnailStorageUrl
            ? { thumbnailStorageKey, thumbnailStorageUrl }
            : {}),
          ...(durationMs != null ? { durationMs } : {}),
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
 * Tiny bounded-retry helper. Used for transient Meta / R2 errors
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
 * Process-wide gate on concurrent inbound-media DOWNLOADS.
 *
 * WHY: each download buffers the whole binary in memory (up to the per-kind cap
 * — 100MB for a WhatsApp document, 25MB for social). The per-webhook-batch
 * `runWithConcurrency(4)` bounds ONE delivery, but Meta fans webhooks out in
 * parallel across all ~30 tenants, so a redelivery burst after downtime can put
 * dozens of full Buffers in flight at once — external memory that is NOT counted
 * against `--max-old-space-size`, so RSS can blow past the 3g cgroup and
 * OOM-kill the api (the same failure class ffmpeg-slots.ts guards for the decode
 * stage). A counting semaphore with a bounded wait caps the aggregate. On
 * wait-timeout the acquire throws into each download's existing catch, which
 * records the outcome (retriable for WhatsApp → the inbound-media sweeper
 * re-fetches; a labeled bubble for social) — no message row is lost. Single
 * process, like every in-memory gate here (CLAUDE.md §16); a second app instance
 * would need a shared counter.
 */
const MEDIA_DOWNLOAD_WAIT_MS = 15_000;

function mediaDownloadMaxConcurrent(): number {
  const raw = Number.parseInt(process.env.MEDIA_DOWNLOAD_CONCURRENCY ?? "8", 10);
  return Number.isFinite(raw) && raw > 0 && raw <= 32 ? raw : 8;
}

let mediaDownloadsActive = 0;
const mediaDownloadWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

function releaseMediaDownloadSlot(): void {
  const next = mediaDownloadWaiters.shift();
  if (next) {
    // Hand the slot straight to the next waiter — do NOT decrement first, or a
    // caller arriving between the decrement and the handoff can steal it and
    // push `active` over the cap (same discipline as ffmpeg-slots.ts).
    next.resolve();
    return;
  }
  mediaDownloadsActive = Math.max(0, mediaDownloadsActive - 1);
}

function acquireMediaDownloadSlot(waitMs: number): Promise<void> {
  if (mediaDownloadsActive < mediaDownloadMaxConcurrent()) {
    mediaDownloadsActive += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const entry = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject,
    };
    const timer = setTimeout(() => {
      const i = mediaDownloadWaiters.indexOf(entry);
      if (i >= 0) mediaDownloadWaiters.splice(i, 1);
      reject(
        new Error(
          `media download slot wait exceeded ${waitMs}ms (${mediaDownloadsActive} active, ${mediaDownloadWaiters.length} queued)`,
        ),
      );
    }, waitMs);
    timer.unref();
    mediaDownloadWaiters.push(entry);
  });
}

/**
 * Run `fn` (a single media download) holding one process-wide slot. Throws if no
 * slot frees within the wait budget; both callers already treat a throw as a
 * failed download and record the appropriate outcome.
 */
async function withMediaDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireMediaDownloadSlot(MEDIA_DOWNLOAD_WAIT_MS);
  try {
    return await fn();
  } finally {
    releaseMediaDownloadSlot();
  }
}

/**
 * Fetch a direct media URL (Messenger / Instagram attachment) into memory,
 * capping by Content-Length before buffering when the CDN sends it. The
 * authoritative post-buffer cap lives in the caller (`downloadSocialMedia`) for
 * CDNs that omit/understate the header. Reads the real mime type from the
 * response. 20s hard timeout so a hung CDN can't pin a connection.
 */
async function fetchUrlBytes(
  url: string,
  capBytes: number,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`social media fetch ${res.status}`);
    // Content-Length is an EARLY reject when present, but a CDN can omit or
    // understate it — so we ALSO enforce the cap while STREAMING the body,
    // aborting the moment accumulated bytes exceed `capBytes`. Never buffer an
    // unbounded response into heap (`res.arrayBuffer()` would): a Content-Length-
    // less multi-hundred-MB attachment must not spike RAM on the shared VPS.
    const cl = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(cl) && cl > capBytes) {
      throw new Error(`social media over cap (content-length ${cl} > ${capBytes})`);
    }
    const bytes = await readBodyCapped(res, capBytes);
    const mimeType =
      (res.headers.get("content-type") ?? "application/octet-stream")
        .split(";")[0]
        ?.trim() || "application/octet-stream";
    return { bytes, mimeType };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a fetch Response body into a Uint8Array, aborting as soon as the running
 * total exceeds `capBytes` — so heap never holds more than ~`capBytes` + one
 * chunk regardless of the (possibly absent/lying) Content-Length header.
 */
async function readBodyCapped(
  res: Awaited<ReturnType<typeof fetch>>,
  capBytes: number,
): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No readable stream — fall back to a full read but still enforce the cap.
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > capBytes) {
      throw new Error(`social media over cap (${buf.length} > ${capBytes})`);
    }
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > capBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`social media over cap (streamed ${total} > ${capBytes})`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
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

/**
 * Defense-in-depth for the social webhook, parallel to `phoneNumberMismatch` on
 * WhatsApp. Every legitimate Messenger/Instagram webhook carries the business
 * account id in `entry[].id` — the Page id (Messenger) or the IG professional
 * account id (Instagram). If the team has that id configured and an incoming
 * entry names a DIFFERENT account, drop the batch rather than ingest messages
 * attributed to the wrong tenant. Skipped when the id isn't configured yet
 * (HMAC against the per-team appSecret remains the primary gate).
 */
function socialEntryIdMismatch(expected: string | null, payload: unknown): boolean {
  if (!expected) return false;
  const p = payload as { entry?: Array<{ id?: string }> };
  const entries = p?.entry;
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    const incoming = entry?.id;
    if (incoming && incoming !== expected) return true;
  }
  return false;
}

/**
 * True if any change in the payload is a Coexistence `history` backfill. Cheap
 * top-level scan so the controller can divert the (potentially huge) chunk to
 * the background worker instead of ingesting it inline. Meta delivers history in
 * its own webhook (never mixed with live messages), so one match ⇒ backfill.
 */
function containsHistory(payload: unknown): boolean {
  const p = payload as { entry?: Array<{ changes?: Array<{ field?: string }> }> };
  const entries = p?.entry;
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    const changes = entry?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (change?.field === "history") return true;
    }
  }
  return false;
}

function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  // One or more candidate secrets. A channel may be verifiable by EITHER the
  // shared Meta App secret OR its own stored secret (when it's connected to a
  // different Meta app than the shared one). Accept if ANY candidate matches —
  // every candidate is a secret the team itself configured, so this never
  // widens trust beyond the team's own apps.
  secret: string | ReadonlyArray<string | undefined>,
): boolean {
  if (!header) return false;
  const b = Buffer.from(header);
  const candidates = typeof secret === "string" ? [secret] : secret;
  for (const s of candidates) {
    if (!s) continue;
    const expected = "sha256=" + createHmac("sha256", s).update(rawBody).digest("hex");
    const a = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * DEV-ONLY escape hatch: skip inbound webhook HMAC verification so local testing
 * over a tunnel never drops an event to a signature mismatch. HARD prod gate —
 * always false when NODE_ENV=production. Opt in with
 * META_WEBHOOK_INSECURE_SKIP_VERIFY=1 (in the root .env). Warns ONCE so it can
 * never be silently on. This is a crutch to unblock local dev, NOT a fix — a
 * wrong app secret drops webhooks in production too, so fix the secret.
 */
let insecureSkipWarned = false;
function insecureSkipVerify(logger: Logger): boolean {
  if (process.env.META_WEBHOOK_INSECURE_SKIP_VERIFY !== "1") return false;
  if (process.env.NODE_ENV === "production") return false;
  if (!insecureSkipWarned) {
    insecureSkipWarned = true;
    logger.warn(
      "META_WEBHOOK_INSECURE_SKIP_VERIFY is ON — inbound webhook signatures are NOT verified (dev only). Never enable in production.",
    );
  }
  return true;
}

/**
 * Build the 403 for a rejected webhook AND log WHY (bare "forbidden" is
 * un-debuggable). A rejected body never reaches the after-verify `wireIn`, so
 * with DEBUG_META_WIRE on we surface it here too — this is how you see the
 * webhooks Meta sent that we're dropping.
 */
function webhookForbidden(
  logger: Logger,
  teamId: string,
  channel: Channel,
  req: Request,
  reason: "no_config" | "no_signature" | "bad_signature",
): HttpException {
  const objectType =
    (req.body as { object?: string } | null | undefined)?.object ?? "?";
  const hint =
    reason === "bad_signature"
      ? "X-Hub-Signature-256 didn't match this channel's stored app secret — re-check the secret in onboarding, or the same callback URL is subscribed under a DIFFERENT Meta app (each app signs with its own secret)."
      : reason === "no_config"
        ? "no webhook config for this team+channel."
        : "Meta sent no signature header.";
  logger.warn(`[${teamId}] ${channel} webhook 403 — ${reason} (object=${objectType}): ${hint}`);
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (rawBody) wireIn(`${channel} REJECTED (${reason})`, rawBody.toString("utf8"));
  return new HttpException("forbidden", 403);
}

/**
 * DEBUG_META_WIRE aid for a bad_signature: print the received signature next to
 * what each STORED secret would produce over these exact bytes. If `received`
 * matches none of the expected values, the stored app secret is simply the wrong
 * value — paste the correct one. For Instagram that is the "Instagram app secret"
 * in the app's Instagram product settings, which is a DIFFERENT value from the
 * Facebook "App Secret" (Settings → Basic). These are HMAC digests (not the
 * secret itself), and only a prefix is shown.
 */
function logSignatureDiag(
  logger: Logger,
  signature: string | undefined,
  rawBody: Buffer,
  candidates: ReadonlyArray<string | undefined>,
): void {
  if (!metaWireEnabled()) return;
  const expected = candidates
    .filter((s): s is string => !!s)
    .map(
      (s, i) =>
        `secret#${i + 1}→${createHmac("sha256", s).update(rawBody).digest("hex").slice(0, 20)}…`,
    );
  const recv = (signature ?? "(none)").replace(/^sha256=/, "").slice(0, 20);
  logger.warn(
    `  ↳ sig diag: received=${recv}…  expected=[ ${expected.join("  ")} ]  ` +
      `— ${expected.length} stored secret(s) tried; matches none ⇒ the stored secret is wrong ` +
      `(Instagram uses the "Instagram app secret", not the Facebook App Secret).`,
  );
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
