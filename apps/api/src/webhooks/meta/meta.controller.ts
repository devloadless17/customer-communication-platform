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
} from "@nestjs/common";
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

    // Two-phase media flow:
    //   1. Sync ingest → message row exists; `message:new` fires with
    //      mediaPending:true ~50ms after receipt.
    //   2. Async download + emit `message:media:ready` after we return 200.
    //
    // Meta's signed media URL has ~5 min window starting on the metadata
    // GET — deferring the download until after the 200 is well inside.
    try {
      await ingestEvents(teamId, "meta_cloud", events);
    } catch (err) {
      this.logger.error(`[${teamId}] ingest failed`, err);
      throw new HttpException("ingest failed", 500);
    }

    void this.downloadInboundMedia(teamId, events).catch((err) =>
      this.logger.error(`[${teamId}] background media download failed`, err),
    );

    return { ok: true, ingested: events.length };
  }

  /**
   * Phase 2 of the inbound media flow — runs detached from the response.
   * Identical logic to the pre-migration route's `downloadInboundMedia`.
   * Single VPS + custom Node server = detached promises continue running
   * after the response (no serverless cold-cutoff). Failures clear the
   * media columns and emit a `message:media:ready` with no media payload
   * so the placeholder drops cleanly.
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

    const externalIds = mediaEvents.map((e) => e.externalId);
    const rows = await this.db.message.findMany({
      where: { teamId, externalId: { in: externalIds } },
      select: { id: true, externalId: true, conversationId: true, mediaUrl: true },
    });
    const rowByExtId = new Map(rows.map((r) => [r.externalId, r]));
    const todo = mediaEvents.filter((e) => {
      const row = rowByExtId.get(e.externalId);
      return row && !row.mediaUrl;
    });
    if (todo.length === 0) return;

    let sendConfig;
    try {
      sendConfig = await getMetaSendConfig(teamId);
    } catch (err) {
      this.logger.warn(`[${teamId}] cannot download media — send config missing`, err);
      await Promise.all(
        todo.map((e) => {
          const row = rowByExtId.get(e.externalId);
          if (!row) return Promise.resolve();
          return this.clearMediaOnRow(teamId, row.id, row.conversationId);
        }),
      );
      return;
    }

    const team = await this.db.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });

    // Same concurrency cap as pre-migration — 4 in-flight covers network
    // latency without piling RAM (each fetch buffers the binary).
    await runWithConcurrency(todo, 4, async (evt) => {
      if (!evt.media) return;
      const row = rowByExtId.get(evt.externalId);
      if (!row) return;
      try {
        const fetched = await getMetaProvider().fetchMedia!(
          evt.media.externalMediaId,
          sendConfig,
        );
        const cap = MEDIA_SIZE_CAPS[evt.media.kind];
        if (fetched.bytes.length > cap) {
          this.logger.warn(
            `[${teamId}] dropping ${evt.media.kind} over cap (${fetched.bytes.length} > ${cap})`,
          );
          await this.clearMediaOnRow(teamId, row.id, row.conversationId);
          return;
        }
        const saved = await blobStorage.upload({
          bytes: fetched.bytes,
          mimeType: fetched.mimeType,
          kind: evt.media.kind,
          context: {
            teamId,
            teamSlug: team?.name,
            direction: "in",
            contactPhone: evt.contactPhone,
            contactName: evt.contactName ?? undefined,
            externalId: evt.externalId,
            originalFilename: evt.media.filename ?? null,
          },
        });

        await this.db.message.update({
          where: { id: row.id },
          data: {
            mediaKey: saved.key,
            mediaUrl: saved.url,
            mediaSizeBytes: saved.sizeBytes,
            mediaMimeType: fetched.mimeType,
          },
        });

        await publish({
          type: "message.media_ready",
          teamId,
          conversationId: row.conversationId,
          messageId: row.id,
          media: {
            kind: evt.media.kind,
            url: `/api/media/${row.id}`,
            mimeType: fetched.mimeType,
            sizeBytes: saved.sizeBytes,
            ...(evt.body ? { caption: evt.body } : {}),
            ...(evt.media.filename ? { filename: evt.media.filename } : {}),
            ...(evt.media.durationMs != null ? { durationMs: evt.media.durationMs } : {}),
          },
        });
      } catch (err) {
        this.logger.error(`[${teamId}] media download failed for ${evt.externalId}`, err);
        await this.clearMediaOnRow(teamId, row.id, row.conversationId);
      }
    });
  }

  private async clearMediaOnRow(
    teamId: string,
    messageId: string,
    conversationId: string,
  ): Promise<void> {
    try {
      await this.db.message.update({
        where: { id: messageId },
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
    } catch (err) {
      this.logger.error(`[${teamId}] clearMediaOnRow failed for ${messageId}`, err);
    }
    await publish({
      type: "message.media_ready",
      teamId,
      conversationId,
      messageId,
    });
  }
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
