import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  Logger,
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  ServiceUnavailableException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import type { Response } from "express";

import { blobStorage } from "@/lib/blob-storage";
import {
  assertAllowedMime,
  assertSignatureMatches,
} from "@/lib/blob-storage/mime-guard";
import { kindFromMime, normalizeMimeType } from "@/lib/media-storage";
import {
  resolveWebchatwidgetByPublicKey,
  widgetAllowsMediaKind,
} from "@/lib/providers/webchatwidget-config";

import { DbService } from "../db/db.service";
import { streamBlob } from "../media/stream-blob";
import { resolvePlayableAudio } from "@/lib/media/playable-audio";
import { originAllowed } from "./origin-allow";
import { WebchatwidgetUploadRateLimitGuard } from "./webchatwidget-rate-limit.guard";

const CHANNEL = "webchatwidget" as const;
/** Max widget upload size — smaller than the agent composer's 100 MB (website
 *  visitors share images / short clips / docs, not multi-GB media). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Process-wide cap on upload bytes buffered on the heap at once (see uploadMedia). */
const MAX_INFLIGHT_UPLOAD_BYTES = 256 * 1024 * 1024;

/**
 * PUBLIC, anonymous widget HTTP surface (no SessionGuard). Authenticated by the
 * public site key + the widget's origin allow-list — the same boundary the
 * visitor socket uses. Only two things are here:
 *   - POST /api/widget/media — a visitor uploads a file; we validate + store it in
 *     R2 and hand back a media ref the widget then attaches to a `visitor:message`.
 *   - GET  /api/widget/media/:messageId — serve a visitor THEIR OWN conversation's
 *     media (agent replies + their own uploads), scoped by (site key, visitor id).
 *   - GET  /api/widget/config — appearance config for first paint (see below).
 */
@Controller("api/widget")
export class WebchatwidgetPublicController {
  private readonly logger = new Logger(WebchatwidgetPublicController.name);
  /** Static — one counter per process, shared by every request. */
  private static inflightUploadBytes = 0;

  constructor(private readonly db: DbService) {}

  /**
   * Appearance config for the launcher's FIRST PAINT.
   *
   * This exists so the widget does not have to hold a WebSocket open just to learn
   * its own colours. `boot()` used to connect on every page load, which meant the
   * number of live sockets equalled the number of people *browsing* every customer
   * site — not the number of people chatting — and that is the dominant scaling
   * cost of this channel. With config over plain HTTP the widget paints correctly
   * while staying socket-less until the visitor actually opens the chat (or has an
   * existing thread to receive replies on).
   *
   * Returns exactly the shape the socket's `ready` event carries, so the widget has
   * one code path for both. Same auth boundary as the rest of this controller:
   * public site key + origin allow-list. Nothing here is visitor-scoped, so there
   * is no per-visitor data to leak — it is the same config already embedded in
   * every page that renders the widget.
   */
  @Get("config")
  async getConfig(
    @Query("key") siteKey: string | undefined,
    @Headers("origin") origin: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ widgetId: string; name: string; config: unknown }> {
    const resolved = await this.resolve(siteKey, origin, "http");
    // Appearance changes rarely and every page load fetches this; a short cache
    // spares the API a request per pageview without making edits take long to
    // appear. Config is non-sensitive and public, so `public` is correct.
    res.setHeader("Cache-Control", "public, max-age=300");
    return { widgetId: resolved.widgetId, name: resolved.name, config: resolved.config };
  }

  @Post("media")
  @UseGuards(WebchatwidgetUploadRateLimitGuard)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_UPLOAD_BYTES },
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, _file, cb) => cb(null, `ccp-widget-${randomUUID()}`),
      }),
    }),
  )
  async uploadMedia(
    @Query("key") siteKey: string | undefined,
    @Headers("origin") origin: string | undefined,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{
    mediaKey: string;
    mediaUrl: string;
    kind: string;
    mimeType: string;
    sizeBytes: number;
    filename?: string;
  }> {
    if (!file) throw new BadRequestException({ error: "file_required" });
    // Process-wide ceiling on bytes BUFFERED for widget uploads at any instant.
    // The per-IP bucket bounds one client, not a fleet: uploads land on disk via
    // multer but are read whole onto the heap below for the signature check + blob
    // put, so N concurrent 25MB uploads from many IPs would approach the api
    // service's heap limit. 503 is deliberate — transient, the widget's retry
    // path handles it — and the counter is released in the inner finally.
    if (WebchatwidgetPublicController.inflightUploadBytes + file.size > MAX_INFLIGHT_UPLOAD_BYTES) {
      await unlink(file.path).catch(() => undefined);
      throw new ServiceUnavailableException({ error: "upload_busy", detail: "Too many uploads right now — try again in a moment." });
    }
    WebchatwidgetPublicController.inflightUploadBytes += file.size;
    try {
      // STRICT: a browser always sends Origin on a POST, so a missing one here
      // is a script — see the transport note on resolve().
      const resolved = await this.resolve(siteKey, origin, "websocket");
      const bytes = new Uint8Array(await readFile(file.path));
      const mimeType = normalizeMimeType(file.mimetype || "application/octet-stream");
      // Reject a spoofed Content-Type (e.g. SVG bytes labeled image/png) and any
      // kind outside the allow-list — same guards the inbound Meta media path uses.
      assertSignatureMatches(bytes, mimeType);
      const kind = kindFromMime(mimeType, CHANNEL);
      assertAllowedMime(kind, mimeType);
      // The organization's own attachment policy. Enforced HERE and not merely in
      // the widget, because the widget is code running on a visitor's machine — the
      // hidden button is a courtesy, this is the control. An org that turned off
      // documents must not receive documents from a crafted client.
      if (!widgetAllowsMediaKind(resolved.config, kind)) {
        throw new BadRequestException({ error: "media_kind_not_allowed", detail: `This chat doesn't accept ${kind} attachments.` });
      }

      const originalFilename = file.originalname
        ? Buffer.from(file.originalname, "latin1").toString("utf8")
        : null;
      const uploaded = await blobStorage.upload({
        bytes,
        mimeType,
        kind,
        context: {
          workspaceId: resolved.workspaceId,
          direction: "in",
          externalId: `webchatwidget-${randomUUID()}`,
          ...(originalFilename ? { originalFilename } : {}),
        },
      });
      return {
        mediaKey: uploaded.key,
        mediaUrl: uploaded.url,
        kind,
        mimeType,
        sizeBytes: uploaded.sizeBytes,
        ...(kind === "document" && originalFilename ? { filename: originalFilename } : {}),
      };
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof NotFoundException) throw err;
      // A BadRequest raised deliberately above (e.g. media_kind_not_allowed) already
      // carries the precise reason — re-wrapping it as a generic `upload_rejected`
      // would hide that from the visitor. The mime/signature guards throw plain
      // Errors, so they still fall through to the generic shape below.
      if (err instanceof BadRequestException) throw err;
      // A mime/signature rejection is a client error, not a 500.
      // PUBLIC, UNAUTHENTICATED surface — a website visitor is on the other
      // end. Anything the R2/blob layer throws (bucket name, endpoint host,
      // internal path) was going back verbatim. Logged, not echoed.
      this.logger.warn(
        `widget upload rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException({
        error: "upload_rejected",
        detail: "This file could not be uploaded. Try a different file.",
      });
    } finally {
      WebchatwidgetPublicController.inflightUploadBytes -= file.size;
      await unlink(file.path).catch(() => undefined);
    }
  }

  @Get("media/:messageId")
  async getMedia(
    @Param("messageId") messageId: string,
    @Query("key") siteKey: string | undefined,
    @Query("v") visitorId: string | undefined,
    @Query("thumb") thumb: string | undefined,
    @Query("download") download: string | undefined,
    @Query("playable") playable: string | undefined,
    @Headers("range") range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // Media is loaded by <img>/<video>/<audio> src (not CORS-enforced), so this
    // route is reached directly. Ownership is the real gate: the message must
    // belong to THIS visitor's conversation on THIS widget.
    const resolved = await resolveWebchatwidgetByPublicKey(siteKey ?? "");
    if (!resolved || !visitorId) throw new NotFoundException({ error: "not_found" });
    const externalContactId = `${resolved.widgetId}:${visitorId}`;
    const message = await this.db.message.findFirst({
      where: {
        id: messageId,
        workspaceId: resolved.workspaceId,
        channel: CHANNEL,
        conversation: { contact: { identityChannel: CHANNEL, externalContactId } },
      },
      select: {
        mediaKey: true,
        mediaThumbnailKey: true,
        mediaFilename: true,
        mediaKind: true,
        mediaMimeType: true,
      },
    });
    if (!message) throw new NotFoundException({ error: "not_found" });
    let key = thumb ? message.mediaThumbnailKey : message.mediaKey;
    if (!key) throw new NotFoundException({ error: "not_found" });
    // Visitor-side Safari (macOS and every iPhone before 18.4) can't decode the
    // agent's ogg/opus voice notes — same compat shim as the inbox media route.
    if (playable && !thumb && !download) {
      key = await resolvePlayableAudio(key, message.mediaMimeType);
    }
    await streamBlob(res, key, range, {
      ...(download && !thumb
        ? { downloadFilename: message.mediaFilename ?? `${message.mediaKind ?? "file"}` }
        : {}),
    });
  }

  /**
   * Resolve + origin-gate a site key, or throw a 404/403.
   *
   * `transport` picks how a MISSING Origin is read, and the two routes here
   * need opposite answers:
   *
   *   - `getConfig` is a same-origin GET from widget.js, and per the Fetch spec
   *     a same-origin GET omits Origin entirely → "http", missing is fine.
   *   - `uploadMedia` is a POST, and a browser ALWAYS sends Origin on a POST.
   *     So a missing one there means a script, and being lenient made the
   *     allow-list a no-op on the one route that WRITES: anyone could read the
   *     public site key out of a customer's page source and curl unlimited
   *     files into that tenant's R2 prefix with no Origin header, no visitorId
   *     and no conversation — orphan blobs billed to the tenant, bounded only
   *     by the 60/min/IP guard. It has to be read strictly → "websocket".
   *
   * (This leniency was introduced to fix a real 403 on the config fetch and
   * immediately widened the upload route. Keep the two apart.)
   */
  private async resolve(
    siteKey: string | undefined,
    origin: string | undefined,
    transport: "websocket" | "http" = "websocket",
  ) {
    const resolved = await resolveWebchatwidgetByPublicKey(siteKey ?? "");
    if (!resolved) throw new NotFoundException({ error: "unknown_site_key" });
    if (!originAllowed(origin ?? null, resolved.allowedOrigins, transport)) {
      throw new ForbiddenException({ error: "origin_not_allowed" });
    }
    return resolved;
  }
}
