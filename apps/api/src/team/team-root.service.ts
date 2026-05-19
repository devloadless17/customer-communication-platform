import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";

import { blobStorage } from "@/lib/blob-storage";
import { invalidateProviderConfig } from "@/lib/providers/config";

import { SessionInvalidationService } from "../auth/session-invalidation.service";
import { DbService } from "../db/db.service";

/**
 * Whole-team destroy. Cascades through every team-scoped table (users,
 * contacts, conversations, messages, notes, templates, broadcasts, invites,
 * automations, api keys, sessions, accounts, blob references) in a single
 * Prisma delete. Used by both:
 *
 *   - DELETE /api/team          (admin removing their own org)
 *   - DELETE /api/admin/teams/:id (superAdmin removing any org)
 *
 * Blob cleanup is best-effort: a partial UploadThing failure leaves orphan
 * files but does NOT block the DB delete. Orphans cost storage, not
 * correctness.
 */
@Injectable()
export class TeamRootService {
  private readonly logger = new Logger(TeamRootService.name);

  constructor(
    private readonly db: DbService,
    private readonly sessionInvalidator: SessionInvalidationService,
  ) {}

  async destroy(teamId: string, label: string): Promise<void> {
    // Snapshot blob keys + member ids BEFORE the cascade nukes the rows.
    // Blob keys feed post-delete cleanup; member ids feed the explicit
    // socket kick (the cascade clears their Session rows but already-
    // connected sockets stay live until kicked).
    const [blobKeyRows, teamMembers] = await Promise.all([
      this.db.message.findMany({
        where: { teamId, mediaKey: { not: null } },
        select: { mediaKey: true },
      }),
      this.db.user.findMany({ where: { teamId }, select: { id: true } }),
    ]);
    const blobKeys = blobKeyRows
      .map((r) => r.mediaKey)
      .filter((k): k is string => Boolean(k));

    try {
      await this.db.team.delete({ where: { id: teamId } });
    } catch (err) {
      this.logger.error(`[${label}] cascade delete failed`, err);
      throw new InternalServerErrorException({
        error: "delete failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    invalidateProviderConfig(teamId);

    // Revoke each member through the unified path so the per-process
    // session cache is busted alongside the socket kick. The cascade
    // already deleted Session rows; this just clears the local caches +
    // closes live connections so members don't keep operating against
    // the (now-deleted) team for the cache TTL.
    for (const m of teamMembers) {
      this.sessionInvalidator.revoke(m.id, "team-deletion");
    }

    // Fire-and-forget blob cleanup. blobStorage.delete promises never throw.
    if (blobKeys.length > 0) {
      void blobStorage.delete(blobKeys);
    }
  }
}
