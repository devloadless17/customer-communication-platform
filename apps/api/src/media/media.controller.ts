import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { blobStorage } from "@/lib/blob-storage";

import { CurrentSession } from "../auth/current-session.decorator";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { DbService } from "../db/db.service";

/**
 * GET /api/media/:messageId
 *
 * Authenticated redirect to the blob provider's CDN URL.
 *   - Same-team check before leaking the URL.
 *   - Stable public path while the underlying provider can swap.
 *   - 302 with `private, max-age=31536000, immutable` (1 year) so each
 *     user's browser caches the redirect for the lifetime of the install
 *     AND skips revalidation on F5 / new tab. Safe because the underlying
 *     blob URL is content-addressed (UploadThing fileKey is derived from
 *     bytes) — the URL for a given messageId never changes. `Vary: Cookie`
 *     belt-and-suspenders against a future shared cache misroute.
 *   - Open-redirect guard: refuses URLs that aren't from the active
 *     blob provider's host (defense against a future ingest bug that
 *     ends up writing an attacker URL into the column).
 */
@Controller("api/media")
@UseGuards(SessionGuard)
export class MediaController {
  constructor(private readonly db: DbService) {}

  @Get(":messageId")
  async get(
    @CurrentSession() session: ApiSession,
    @Param("messageId") messageId: string,
    @Res() res: Response,
  ): Promise<void> {
    const message = await this.db.message.findFirst({
      where: { id: messageId, teamId: session.teamId },
      select: { mediaUrl: true, mediaKind: true },
    });
    if (!message?.mediaUrl) {
      throw new NotFoundException("not found");
    }
    if (!blobStorage.isOwnUrl(message.mediaUrl)) {
      // Open-redirect guard — keep the response indistinguishable from
      // "no such message" so attackers don't learn the validation rules.
      throw new NotFoundException("not found");
    }
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.set("Vary", "Cookie");
    res.redirect(302, message.mediaUrl);
  }

  /**
   * Video poster frame — same auth-redirect contract as the main media route
   * above. 404s on rows without a thumbnail (rows that predate M8 or whose
   * ffmpeg extraction failed); the VideoBlock falls back to bg-black there.
   */
  @Get(":messageId/thumb")
  async getThumbnail(
    @CurrentSession() session: ApiSession,
    @Param("messageId") messageId: string,
    @Res() res: Response,
  ): Promise<void> {
    const message = await this.db.message.findFirst({
      where: { id: messageId, teamId: session.teamId },
      select: { mediaThumbnailUrl: true },
    });
    if (!message?.mediaThumbnailUrl) {
      throw new NotFoundException("not found");
    }
    if (!blobStorage.isOwnUrl(message.mediaThumbnailUrl)) {
      throw new NotFoundException("not found");
    }
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.set("Vary", "Cookie");
    res.redirect(302, message.mediaThumbnailUrl);
  }
}
