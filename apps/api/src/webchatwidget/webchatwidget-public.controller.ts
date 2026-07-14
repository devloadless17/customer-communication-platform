import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
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
import { resolveWebchatwidgetByPublicKey } from "@/lib/providers/webchatwidget-config";

import { DbService } from "../db/db.service";
import { streamBlob } from "../media/stream-blob";
import { originAllowed } from "./origin-allow";
import { WebchatwidgetUploadRateLimitGuard } from "./webchatwidget-rate-limit.guard";

const CHANNEL = "webchatwidget" as const;
/** Max widget upload size — smaller than the agent composer's 100 MB (website
 *  visitors share images / short clips / docs, not multi-GB media). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * PUBLIC, anonymous widget HTTP surface (no SessionGuard). Authenticated by the
 * public site key + the widget's origin allow-list — the same boundary the
 * visitor socket uses. Only two things are here:
 *   - POST /api/widget/media — a visitor uploads a file; we validate + store it in
 *     R2 and hand back a media ref the widget then attaches to a `visitor:message`.
 *   - GET  /api/widget/media/:messageId — serve a visitor THEIR OWN conversation's
 *     media (agent replies + their own uploads), scoped by (site key, visitor id).
 * Appearance/pre-chat config is delivered over the socket (`ready` event), not
 * here, so there's no cross-origin config fetch.
 */
@Controller("api/widget")
export class WebchatwidgetPublicController {
  constructor(private readonly db: DbService) {}

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
    try {
      const resolved = await this.resolve(siteKey, origin);
      const bytes = new Uint8Array(await readFile(file.path));
      const mimeType = normalizeMimeType(file.mimetype || "application/octet-stream");
      // Reject a spoofed Content-Type (e.g. SVG bytes labeled image/png) and any
      // kind outside the allow-list — same guards the inbound Meta media path uses.
      assertSignatureMatches(bytes, mimeType);
      const kind = kindFromMime(mimeType);
      assertAllowedMime(kind, mimeType);

      const originalFilename = file.originalname
        ? Buffer.from(file.originalname, "latin1").toString("utf8")
        : null;
      const uploaded = await blobStorage.upload({
        bytes,
        mimeType,
        kind,
        context: {
          teamId: resolved.teamId,
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
      // A mime/signature rejection is a client error, not a 500.
      throw new BadRequestException({
        error: "upload_rejected",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
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
        teamId: resolved.teamId,
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
    const key = thumb ? message.mediaThumbnailKey : message.mediaKey;
    if (!key) throw new NotFoundException({ error: "not_found" });
    await streamBlob(res, key, range, {
      ...(download && !thumb
        ? { downloadFilename: message.mediaFilename ?? `${message.mediaKind ?? "file"}` }
        : {}),
    });
  }

  /** Resolve + origin-gate a site key, or throw a 404/403. */
  private async resolve(siteKey: string | undefined, origin: string | undefined) {
    const resolved = await resolveWebchatwidgetByPublicKey(siteKey ?? "");
    if (!resolved) throw new NotFoundException({ error: "unknown_site_key" });
    if (!originAllowed(origin ?? null, resolved.allowedOrigins)) {
      throw new ForbiddenException({ error: "origin_not_allowed" });
    }
    return resolved;
  }
}
