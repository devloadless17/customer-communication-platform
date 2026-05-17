import { Injectable, InternalServerErrorException, Logger } from "@nestjs/common";

import { blobStorage } from "@/lib/blob-storage";
import { invalidateProviderConfig } from "@/lib/providers/config";

import { PrismaService } from "../prisma/prisma.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";

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
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async destroy(teamId: string, label: string): Promise<void> {
    // Snapshot blob keys + member ids BEFORE the cascade nukes the rows.
    // Blob keys feed post-delete cleanup; member ids feed the explicit
    // socket kick (the cascade clears their Session rows but already-
    // connected sockets stay live until kicked).
    const [blobKeyRows, teamMembers] = await Promise.all([
      this.prisma.message.findMany({
        where: { teamId, mediaKey: { not: null } },
        select: { mediaKey: true },
      }),
      this.prisma.user.findMany({ where: { teamId }, select: { id: true } }),
    ]);
    const blobKeys = blobKeyRows
      .map((r) => r.mediaKey)
      .filter((k): k is string => Boolean(k));

    try {
      await this.prisma.team.delete({ where: { id: teamId } });
    } catch (err) {
      this.logger.error(`[${label}] cascade delete failed`, err);
      throw new InternalServerErrorException({
        error: "delete failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    invalidateProviderConfig(teamId);

    let droppedSockets = 0;
    for (const m of teamMembers) {
      droppedSockets += this.realtime.disconnectUserSockets(m.id);
    }
    if (droppedSockets > 0) {
      this.logger.log(
        `[${label}] dropped ${droppedSockets} live socket(s) across ${teamMembers.length} member(s)`,
      );
    }

    // Fire-and-forget blob cleanup. blobStorage.delete promises never throw.
    if (blobKeys.length > 0) {
      void blobStorage.delete(blobKeys);
    }
  }
}
