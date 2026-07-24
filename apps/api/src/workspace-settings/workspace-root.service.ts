import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from "@nestjs/common";
import type { AiHandoffAction, FirstTouchGreeter, Prisma } from "@prisma/client";

import { blobStorage } from "@/lib/blob-storage";
import { avatarObjectKey, contactAvatarObjectKey } from "@/lib/blob-storage/avatar";
import { invalidateProviderConfig } from "@/lib/providers/config";

import { SessionInvalidationService } from "../auth/session-invalidation.service";
import { DbService } from "../db/db.service";
import { EventBus } from "../events/event-bus.module";

/**
 * Destroy, at two levels:
 *
 *   - `destroy(workspaceId)`            — ONE workspace and every
 *     workspace-scoped table under it (contacts, conversations, messages,
 *     notes, templates, broadcasts, invites, automations, api keys, blob
 *     references).
 *   - `destroyOrganization(orgId)`      — every workspace in the org, then the
 *     org row, which cascades the USER DIRECTORY. `User` hangs off
 *     `Organization`, not `Workspace`, so only this level actually removes a
 *     tenant. Both delete routes use it:
 *       DELETE /api/workspace        (owner removing their own organization)
 *       DELETE /api/admin/teams/:id  (superAdmin removing any organization)
 *
 * Blob cleanup is best-effort: a partial R2 failure leaves orphan
 * files but does NOT block the DB delete. Orphans cost storage, not
 * correctness.
 */
@Injectable()
export class WorkspaceRootService {
  private readonly logger = new Logger(WorkspaceRootService.name);

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
  async rename(workspaceId: string, name: string, actorUserId: string): Promise<{ name: string }> {
    const team = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    });
    if (!team) throw new NotFoundException({ error: "team not found" });
    if (team.name === name) return { name };

    const updated = await this.db.workspace.update({
      where: { id: workspaceId },
      data: { name },
      select: { name: true },
    });

    await this.bus.publish({
      type: "team.renamed",
      workspaceId,
      name: updated.name,
      renamedByUserId: actorUserId,
    });

    return { name: updated.name };
  }

  /**
   * Update the org's AI behavior settings (handoff action, first-touch greeter,
   * session window). Each field is optional — the UI can save one at a time.
   * Rule that lives here so it can't drift: `assign_fixed` requires a real,
   * active member of THIS team; clearing/removing the assignee is allowed for
   * other actions (it's just ignored unless the action is assign_fixed).
   */
  async updateAiSettings(
    workspaceId: string,
    input: {
      aiHandoffAction?: AiHandoffAction;
      aiHandoffAssigneeId?: string | null;
      firstTouchGreeter?: FirstTouchGreeter;
    },
  ): Promise<{
    aiHandoffAction: AiHandoffAction;
    aiHandoffAssigneeId: string | null;
    firstTouchGreeter: FirstTouchGreeter;
  }> {
    const current = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { aiHandoffAction: true, aiHandoffAssigneeId: true },
    });
    if (!current) throw new NotFoundException({ error: "team not found" });

    const nextAction = input.aiHandoffAction ?? current.aiHandoffAction;
    // The assignee after this write (explicit value wins, else keep current).
    const nextAssignee =
      input.aiHandoffAssigneeId !== undefined
        ? input.aiHandoffAssigneeId
        : current.aiHandoffAssigneeId;

    if (nextAction === "assign_fixed") {
      if (!nextAssignee) {
        throw new BadRequestException({
          error: "assignee_required",
          detail: "assign_fixed requires aiHandoffAssigneeId",
        });
      }
      const member = await this.db.user.findFirst({
        where: { id: nextAssignee, workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null },
        select: { id: true },
      });
      if (!member) {
        throw new BadRequestException({
          error: "invalid_assignee",
          detail: "aiHandoffAssigneeId must be an active member of this team",
        });
      }
    }

    const data: Prisma.WorkspaceUpdateInput = {};
    if (input.aiHandoffAction !== undefined) data.aiHandoffAction = input.aiHandoffAction;
    if (input.aiHandoffAssigneeId !== undefined) {
      data.aiHandoffAssignee = input.aiHandoffAssigneeId
        ? { connect: { id: input.aiHandoffAssigneeId } }
        : { disconnect: true };
    }
    if (input.firstTouchGreeter !== undefined) data.firstTouchGreeter = input.firstTouchGreeter;

    const updated = await this.db.workspace.update({
      where: { id: workspaceId },
      data,
      select: {
        aiHandoffAction: true,
        aiHandoffAssigneeId: true,
        firstTouchGreeter: true,
      },
    });
    return updated;
  }

  /**
   * DB-2: delete a team's Message rows in bounded batches so a huge tenant's
   * hard-delete doesn't run as one multi-million-row transaction. FK-safe in any
   * order (Message's only inbound FK is the self-referential replyTo SetNull).
   */
  private async batchDeleteMessagesByTeam(workspaceId: string): Promise<void> {
    const BATCH = 5_000;
    // Safety ceiling so a bug can't spin forever; 200k × 5k = 1B rows, far above
    // any real tenant — the `< BATCH` break is the normal exit.
    const MAX_BATCHES = 200_000;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const deleted = await this.db.$executeRaw`
        DELETE FROM "Message"
        WHERE id IN (
          SELECT id FROM "Message" WHERE "workspaceId" = ${workspaceId} LIMIT ${BATCH}
        )
      `;
      if (Number(deleted) < BATCH) break;
    }
  }

  /**
   * Every message media/thumbnail key for a team, in bounded pages.
   *
   * Was a single unbounded `findMany`. Message is by far the heaviest table
   * here — the drain loop below exists precisely because it can hold MILLIONS
   * of rows for a long-lived tenant — so materializing every media key at once
   * is a heap spike on exactly the tenant where deletion matters most, and it
   * happens BEFORE anything is deleted, so the purge dies before it starts.
   */
  private async collectMessageBlobKeys(workspaceId: string): Promise<string[]> {
    const keys: string[] = [];
    const PAGE = 1_000;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.db.message.findMany({
        // Both the media binary (mediaKey) AND the video poster-frame thumbnail
        // (mediaThumbnailKey) are independent blobs — collect both so the team
        // purge doesn't leak posters (audit fix F1d). The blob-orphan sweeper
        // backstops anything missed, but immediate cleanup is cheaper.
        where: {
          workspaceId,
          OR: [{ mediaKey: { not: null } }, { mediaThumbnailKey: { not: null } }],
        },
        select: { id: true, mediaKey: true, mediaThumbnailKey: true },
        orderBy: { id: "asc" },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const m of page) {
        if (m.mediaKey) keys.push(m.mediaKey);
        if (m.mediaThumbnailKey) keys.push(m.mediaThumbnailKey);
      }
      if (page.length < PAGE) break;
      cursor = page[page.length - 1]?.id;
      if (!cursor) break;
    }
    return keys;
  }

  /** Captured social-contact avatar keys, paged for the same reason. */
  private async collectContactAvatarKeys(workspaceId: string): Promise<string[]> {
    const keys: string[] = [];
    const PAGE = 1_000;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.db.contact.findMany({
        where: { workspaceId, avatarUrl: { not: null } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const c of page) keys.push(contactAvatarObjectKey(c.id));
      if (page.length < PAGE) break;
      cursor = page[page.length - 1]?.id;
      if (!cursor) break;
    }
    return keys;
  }

  async destroy(workspaceId: string, label: string): Promise<void> {
    // Snapshot blob keys + member ids BEFORE the cascade nukes the rows.
    // Blob keys feed post-delete cleanup; member ids feed the explicit
    // socket kick (the cascade clears their Session rows but already-
    // connected sockets stay live until kicked).
    const [messageBlobKeys, contactAvatarKeys, teamMembers] = await Promise.all([
      this.collectMessageBlobKeys(workspaceId),
      this.collectContactAvatarKeys(workspaceId),
      this.db.user.findMany({ where: { workspaceMemberships: { some: { workspaceId } } }, select: { id: true, avatarUrl: true } }),
    ]);
    const blobKeys = messageBlobKeys
      // Each member's avatar is an independent R2 blob under the `avatars/`
      // prefix (deterministic `avatars/{userId}` key) — the cascade drops the
      // User rows but not the objects, so collect them too (F48). Only members
      // with a stored avatar have an object to delete.
      .concat(teamMembers.filter((m) => m.avatarUrl).map((m) => avatarObjectKey(m.id)))
      // CONTACT avatars were missed entirely. Social contacts (Messenger /
      // Instagram) get their profile picture captured to `avatars/contact-{id}`
      // because Meta's own URL expires; nothing ever deleted those objects —
      // not this purge, and not the blob-orphan sweeper, which skips the whole
      // `avatars/` prefix. A churned enterprise tenant with 200k social
      // contacts therefore left ~200k orphaned objects in R2, billed forever
      // with no row, no reference, and no reclaim path anywhere in the tree.
      .concat(contactAvatarKeys);

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
      await this.batchDeleteMessagesByTeam(workspaceId);
      await this.db.workspace.delete({ where: { id: workspaceId } });
    } catch (err) {
      this.logger.error(`[${label}] cascade delete failed`, err);
      throw new InternalServerErrorException({
        error: "delete failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    invalidateProviderConfig(workspaceId);

    // Revoke each member through the unified path so the per-process
    // session cache is busted alongside the socket kick. The cascade
    // already deleted Session rows; this just clears the local caches +
    // closes live connections so members don't keep operating against
    // the (now-deleted) team for the cache TTL.
    for (const m of teamMembers) {
      this.sessionInvalidator.revoke(m.id, "team-deletion");
    }

    // Fire-and-forget blob cleanup. blobStorage.delete promises never
    // throw — R2's DeleteObjects is the underlying call and it batches
    // internally (≤1000/req), but throwing thousands of keys in one POST
    // can hit the request-size cap on a chatty large team. Chunk to
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

  /**
   * Destroy an entire ORGANIZATION — every workspace in it, then the org row
   * itself (which cascades the user directory).
   *
   * `destroy()` above removes ONE workspace, and that is not what deleting a
   * tenant means: `User` hangs off `Organization`, not `Workspace`, so dropping
   * the last workspace used to leave the org row and every member account
   * alive. The result was unreachable rather than merely untidy — the platform
   * list enumerates workspaces, so a zero-workspace org disappeared from the
   * only UI that can delete it, while `User.email` (globally unique, and one
   * email belongs to exactly one org) stayed claimed forever. The person could
   * neither sign in nor sign up again.
   *
   * Workspaces are destroyed one at a time through `destroy()` so each keeps
   * the bounded message pre-drain, the blob snapshot and the socket kick.
   * Deleting the org row alone would cascade every table at once — the lock
   * storm `destroy()` exists to avoid.
   */
  async destroyOrganization(organizationId: string, label: string): Promise<void> {
    const workspaces = await this.db.workspace.findMany({
      where: { organizationId },
      select: { id: true },
      orderBy: { id: "asc" },
    });

    for (const ws of workspaces) {
      await this.destroy(ws.id, `${label} → workspace ${ws.id}`);
    }

    // Members with no workspace membership (an owner who never joined one, or
    // an invited user who never accepted) are unreachable by the loop above and
    // are exactly the rows that stranded the email address. Revoke them before
    // the cascade so live sockets close and the session caches drop.
    const orphans = await this.db.user.findMany({
      where: { organizationId },
      select: { id: true },
    });

    try {
      await this.db.organization.delete({ where: { id: organizationId } });
    } catch (err) {
      this.logger.error(`[${label}] organization delete failed`, err);
      throw new InternalServerErrorException({
        error: "delete failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }

    for (const u of orphans) {
      this.sessionInvalidator.revoke(u.id, "organization-deletion");
    }
  }
}
