import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
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

  /**
   * Liveness probe for a raw blob-provider URL (e.g. the team-chat path
   * exposes the upstream URL directly). Returns `{ available: boolean }`
   * without redirecting so the client can render an in-app fallback
   * instead of landing the user on the provider's branded 404 page.
   * Hosts that aren't from the active blob provider are rejected —
   * symmetric with the open-redirect guard on the message-id route.
   */
  @Get("probe")
  async probe(
    @Query("url") rawUrl: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!rawUrl || !blobStorage.isOwnUrl(rawUrl)) {
      res.status(200).json({ available: false, reason: "missing" });
      return;
    }
    const ok = await probeUpstream(rawUrl);
    res.status(200).json(
      ok ? { available: true } : { available: false, reason: "upstream_missing" },
    );
  }

  @Get(":messageId")
  async get(
    @CurrentSession() session: ApiSession,
    @Param("messageId") messageId: string,
    @Query("probe") probe: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const message = await this.db.message.findFirst({
      where: { id: messageId, teamId: session.teamId },
      select: { mediaUrl: true, mediaKind: true },
    });
    if (!message?.mediaUrl) {
      // Probe variant returns a clean JSON shape so the client can render
      // an in-app "file unavailable" state instead of redirecting the user
      // to the upstream's branded 404 page.
      if (probe) {
        res.status(200).json({ available: false, reason: "missing" });
        return;
      }
      throw new NotFoundException({ error: "not_found" });
    }
    if (!blobStorage.isOwnUrl(message.mediaUrl)) {
      // Open-redirect guard — keep the response indistinguishable from
      // "no such message" so attackers don't learn the validation rules.
      if (probe) {
        res.status(200).json({ available: false, reason: "missing" });
        return;
      }
      throw new NotFoundException({ error: "not_found" });
    }
    if (probe) {
      // HEAD the upstream so the client can avoid opening a tab that would
      // land on the third-party 404 page. 6s ceiling — well under the UI's
      // "user clicked Open" patience. Network errors or non-2xx upstream
      // collapse to `available: false` so the client always shows the
      // in-app fallback rather than the upstream brand.
      const upstreamOk = await probeUpstream(message.mediaUrl);
      res.status(200).json(
        upstreamOk
          ? { available: true }
          : { available: false, reason: "upstream_missing" },
      );
      return;
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
      throw new NotFoundException({ error: "not_found" });
    }
    if (!blobStorage.isOwnUrl(message.mediaThumbnailUrl)) {
      throw new NotFoundException({ error: "not_found" });
    }
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.set("Vary", "Cookie");
    res.redirect(302, message.mediaThumbnailUrl);
  }
}

/**
 * Quick liveness check against the blob provider's CDN. Used by the `?probe=1`
 * branch above to tell the client whether opening a tab will land on the file
 * or on the provider's branded 404. Bounded at 6s so a hung upstream can't
 * stall the request — a slow provider reads the same as "gone" from a UX
 * perspective, both surface the in-app fallback.
 */
async function probeUpstream(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const r = await fetch(url, { method: "HEAD", signal: controller.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
