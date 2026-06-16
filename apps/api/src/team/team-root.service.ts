import { Injectable, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";

import { blobStorage } from "@/lib/blob-storage";
import { invalidateProviderConfig } from "@/lib/providers/config";

import { SessionInvalidationService } from "../auth/session-invalidation.service";
import { DbService } from "../db/db.service";
import { EventBus } from "../events/event-bus.module";

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
    private readonly bus: EventBus,
  ) {}

  /**
   * Rename the team. Idempotent on the input — a no-op when the trimmed
   * name matches the current row (returns the existing name without a write
   * or a publish, so a "save" of unchanged text doesn't churn every open
   * sidebar). Throws NotFound if the team is gone (race with delete).
   */
  async rename(teamId: string, name: string, actorUserId: string): Promise<{ name: string }> {
    const team = await this.db.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });
    if (!team) throw new NotFoundException({ error: "team not found" });
    if (team.name === name) return { name };

    const updated = await this.db.team.update({
      where: { id: teamId },
      data: { name },
      select: { name: true },
    });

    await this.bus.publish({
      type: "team.renamed",
      teamId,
      name: updated.name,
      renamedByUserId: actorUserId,
    });

    return { name: updated.name };
  }

  /**
   * DB-2: delete a team's Message rows in bounded batches so a huge tenant's
   * hard-delete doesn't run as one multi-million-row transaction. FK-safe in any
   * order (Message's only inbound FK is the self-referential replyTo SetNull).
   */
  private async batchDeleteMessagesByTeam(teamId: string): Promise<void> {
    const BATCH = 5_000;
    // Safety ceiling so a bug can't spin forever; 200k × 5k = 1B rows, far above
    // any real tenant — the `< BATCH` break is the normal exit.
    const MAX_BATCHES = 200_000;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const deleted = await this.db.$executeRaw`
        DELETE FROM "Message"
        WHERE id IN (
          SELECT id FROM "Message" WHERE "teamId" = ${teamId} LIMIT ${BATCH}
        )
      `;
      if (Number(deleted) < BATCH) break;
    }
  }

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
      // DB-2: pre-drain the Message table in bounded batches BEFORE the cascade.
      // Message is by far the heaviest table (can be MILLIONS of rows for a
      // long-lived tenant); a single `team.delete` cascade would delete them all
      // in ONE transaction — a lock storm + WAL blowup + statement-timeout risk
      // that can wedge the DB. Batching is provably FK-safe here: the only
      // inbound FK to Message is the self-referential `replyTo` (onDelete:
      // SetNull, no Restrict referrers), so batches can run in any order. The
      // final cascade then handles the now-small remainder + every other table +
      // FK integrity. (blobKeys were snapshotted above, before this drains them.)
      await this.batchDeleteMessagesByTeam(teamId);
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

    // Fire-and-forget blob cleanup. blobStorage.delete promises never
    // throw — UploadThing's deleteFiles is the underlying call and it
    // batches internally, but throwing thousands of keys in one POST
    // can hit their request-size cap on a chatty large team. Chunk to
    // 500 keys per call so the worst-case is ~20 sequential batch calls
    // for a 10k-key team, not one giant payload. Sequential (not
    // parallel) inside the fire-and-forget: this is post-delete cleanup,
    // there's no agent waiting for it to finish, and serializing keeps
    // us under any provider per-IP burst limit.
    if (blobKeys.length > 0) {
      const BATCH = 500;
      void (async () => {
        for (let i = 0; i < blobKeys.length; i += BATCH) {
          await blobStorage.delete(blobKeys.slice(i, i + BATCH));
        }
      })();
    }
  }
}
