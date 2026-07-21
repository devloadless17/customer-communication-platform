import {
  Controller,
  Get,
  Headers,
  NotFoundException,
  Param,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { extFromMime } from "@/lib/media-storage";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { conversationRelationWhere } from "@/lib/conversations/visibility";

import { DbService } from "../db/db.service";
import { probeBlob, streamBlob } from "./stream-blob";

/**
 * GET /api/media/:messageId
 *
 * Authenticated SAME-ORIGIN proxy of a private R2 object.
 *   - Same-team check before any bytes are served.
 *   - Streams the object (Range-forwarded so <video>/<audio> seeking works) —
 *     no redirect, no presigned URL, no CSP host juggling. The bucket stays
 *     private; the browser only ever talks to us.
 *   - Bytes for a (messageId → key) never change, so cached 1-year immutable.
 *   - `?probe=1` returns `{ available }` (existence check) so the client can
 *     show an in-app "unavailable" state instead of opening a tab onto a 404.
 *   - Legacy rows whose `mediaKey` points at the old provider simply 404 (the
 *     object isn't in R2) — clean, no special-casing.
 */
@Controller("api/media")
@UseGuards(SessionGuard)
export class MediaController {
  constructor(private readonly db: DbService) {}

  @Get(":messageId")
  async get(
    @CurrentSession() session: ApiSession,
    @Param("messageId") messageId: string,
    @Query("probe") probe: string | undefined,
    @Query("download") download: string | undefined,
    @Headers("range") range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const message = await this.db.message.findFirst({
      // Visibility boundary: a restricted agent may only stream media that
      // belongs to a conversation assigned to them. Without this, message ids
      // leaked by any surface become a direct file-read.
      where: {
        id: messageId,
        teamId: session.teamId,
        ...conversationRelationWhere(session),
      },
      select: { mediaKey: true, mediaFilename: true, mediaKind: true, mediaMimeType: true },
    });
    if (!message?.mediaKey) {
      if (probe) {
        res.status(200).json({ available: false, reason: "missing" });
        return;
      }
      throw new NotFoundException({ error: "not_found" });
    }
    if (probe) {
      const ok = await probeBlob(message.mediaKey);
      res.status(200).json(
        ok ? { available: true } : { available: false, reason: "upstream_missing" },
      );
      return;
    }
    // Default = inline (PDFs/images/video open in-tab). `?download=1` forces a
    // download with a friendly name: the original filename for documents, else
    // a `<kind>.<ext>` derived from the mime (e.g. image.jpg, video.mp4) — never
    // the raw message id.
    await streamBlob(res, message.mediaKey, range, {
      ...(download ? { downloadFilename: downloadNameFor(message) } : {}),
    });
  }

  /**
   * Video poster frame — same proxy contract as the main route. 404s on rows
   * without a thumbnail (rows that predate M8 or whose ffmpeg extraction
   * failed); the VideoBlock falls back to bg-black there.
   */
  @Get(":messageId/thumb")
  async getThumbnail(
    @CurrentSession() session: ApiSession,
    @Param("messageId") messageId: string,
    @Headers("range") range: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const message = await this.db.message.findFirst({
      // Visibility boundary: a restricted agent may only stream media that
      // belongs to a conversation assigned to them. Without this, message ids
      // leaked by any surface become a direct file-read.
      where: {
        id: messageId,
        teamId: session.teamId,
        ...conversationRelationWhere(session),
      },
      select: { mediaThumbnailKey: true },
    });
    if (!message?.mediaThumbnailKey) {
      throw new NotFoundException({ error: "not_found" });
    }
    await streamBlob(res, message.mediaThumbnailKey, range);
  }
}

/**
 * A human-friendly download name. Documents keep the sender's original filename;
 * everything else gets `<kind>.<ext>` from the stored mime (image.jpg,
 * video.mp4, voice.ogg) — anything but the opaque message id the UI used to
 * fall back to.
 */
function downloadNameFor(m: {
  mediaFilename: string | null;
  mediaKind: string | null;
  mediaMimeType: string | null;
}): string {
  if (m.mediaFilename) return m.mediaFilename;
  const ext = extFromMime(m.mediaMimeType ?? "");
  return `${m.mediaKind ?? "file"}.${ext}`;
}
