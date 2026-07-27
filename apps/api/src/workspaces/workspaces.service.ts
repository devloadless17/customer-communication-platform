import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";

import { provisionWorkspace } from "@/lib/workspaces/provision";
import { detachMemberFromWorkspace } from "@/lib/workspaces/remove-member";
import { makeCanAccessBeyondMembership } from "@ccp/shared/auth/active-workspace";

import { invalidateSessionCache, type ApiSession } from "../auth/session.guard";
import { SessionInvalidationService } from "../auth/session-invalidation.service";
import { Prisma } from "@prisma/client";
import { DbService } from "../db/db.service";
import { WorkspaceRootService } from "../workspace-settings/workspace-root.service";
import { joinDefaultChannel } from "@/lib/team-chat/default-channel";

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
  /** True when the user holds an explicit `WorkspaceMember` row here; false when
   *  they can open it purely by org authority. Lets the switcher distinguish
   *  "my workspace" from "one I administer" without a second call. */
  joined: boolean;
}

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    private readonly db: DbService,
    private readonly sessionInvalidator: SessionInvalidationService,
    // The one real implementation of "destroy a workspace" — see remove().
    private readonly workspaceRoot: WorkspaceRootService,
  ) {}

  /**
   * The workspaces this user may act in, for the switcher.
   *
   * For an ordinary member this is their membership set, read straight off the
   * session — `resolveSession` already loaded it, so the switcher costs ZERO
   * extra queries.
   *
   * For an ORG MANAGER (owner / admin / platform operator) it is every workspace
   * in the organization, because that is what `canAccess` and `setActive`
   * already let them open. Returning memberships alone made three surfaces
   * disagree: the Organization page offered "Open" on a workspace the rail
   * switcher didn't list, `setActive` accepted it, and once switched the
   * switcher marked NOTHING as active because the current workspace wasn't in
   * the list it rendered. One rule, applied everywhere it is read.
   */
  async list(session: ApiSession): Promise<WorkspaceSummary[]> {
    const memberRoles = new Map(
      session.workspaceMemberships.map((m) => [m.workspaceId, m.role]),
    );

    if (!this.isOrgManager(session)) {
      return session.workspaceMemberships.map((m) => ({
        id: m.workspaceId,
        name: m.name,
        role: m.role,
        isActive: m.workspaceId === session.workspaceId,
        joined: true,
      }));
    }

    // Scoped to the caller's own org even for a platform operator: `setActive`
    // lets them reach any workspace on the box, but the switcher is a workspace
    // picker, not a directory of every tenant — operators manage from the
    // (platform) shell, and the (app) layout redirects them there anyway.
    const all = await this.db.workspace.findMany({
      where: { organizationId: session.organizationId },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    });

    return all.map((w) => ({
      id: w.id,
      name: w.name,
      // No membership row → they are here by org authority, which resolves to
      // "admin" everywhere in the org (see ApiSession.role).
      role: memberRoles.get(w.id) ?? "admin",
      isActive: w.id === session.workspaceId,
      joined: memberRoles.has(w.id),
    }));
  }

  /**
   * Switch this DEVICE's active workspace.
   *
   * SECURITY: the requested id is client input, so membership is re-validated
   * against the database here rather than trusting the session snapshot — a
   * membership revoked moments ago must not remain switchable for the 15s
   * cache window. An org owner/admin may select any workspace in their own org
   * (they are implicitly admin everywhere in it); a platform superAdmin may
   * select any workspace at all.
   *
   * Writes `Session.activeWorkspaceId` (the durable, per-device truth) and
   * busts the session cache so the very next request resolves the new scope.
   * The caller is responsible for setting the `ccp.ws` cookie and reconnecting
   * the socket so it re-joins the right `ws:` room.
   */
  async setActive(session: ApiSession, workspaceId: string): Promise<void> {
    const allowed = await this.canAccess(session, workspaceId);
    if (!allowed) throw new ForbiddenException({ error: "workspace_forbidden" });

    await this.db.session.update({
      where: { id: session.sessionId },
      data: { activeWorkspaceId: workspaceId },
    });
    invalidateSessionCache(session.userId);
  }

  /**
   * Everything Organization settings renders, in one round-trip.
   *
   * Visible to every member of the org — knowing which workspaces exist and
   * who is in them is directory information, not a privileged secret, and the
   * page is unusable without it. MUTATING any of it is gated separately
   * (`assertCanManage`).
   */
  async organization(session: ApiSession): Promise<OrganizationOverview> {
    const org = await this.db.organization.findUniqueOrThrow({
      where: { id: session.organizationId },
      select: {
        id: true,
        name: true,
        plan: true,
        status: true,
        workspaces: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            createdAt: true,
            _count: {
              select: { members: true, conversations: true, channelConnections: true },
            },
          },
        },
        users: {
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            orgRole: true,
            deactivatedAt: true,
            workspaceMemberships: { select: { workspaceId: true, role: true } },
          },
        },
      },
    });

    const mine = new Set(session.workspaceMemberships.map((m) => m.workspaceId));
    return {
      id: org.id,
      name: org.name,
      plan: org.plan,
      status: org.status,
      workspaces: org.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        memberCount: w._count.members,
        conversationCount: w._count.conversations,
        channelAccountCount: w._count.channelConnections,
        // An org owner/admin can open any workspace in the org even without an
        // explicit membership row — the switcher honours the same rule.
        joined: mine.has(w.id) || this.isOrgManager(session),
        createdAt: w.createdAt.toISOString(),
      })),
      members: org.users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        avatarUrl: u.avatarUrl,
        orgRole: u.orgRole,
        isActive: u.deactivatedAt === null,
        memberships: u.workspaceMemberships,
      })),
      canManage: this.isOrgManager(session),
    };
  }

  async renameOrganization(session: ApiSession, name: string): Promise<{ name: string }> {
    this.assertCanManage(session);
    const org = await this.db.organization.update({
      where: { id: session.organizationId },
      data: { name },
      select: { name: true },
    });
    invalidateSessionCache(session.userId);
    return org;
  }

  /**
   * Create a workspace inside the caller's organization.
   *
   * The creator becomes its first ADMIN — otherwise an org owner could mint a
   * workspace they cannot open, which reads as a broken button. Seeding goes
   * through the same `provisionWorkspace` the signup path uses, so a workspace
   * created here is identical to a signup's.
   */
  async create(session: ApiSession, name: string): Promise<{ id: string; name: string }> {
    this.assertCanManage(session);

    // The cap is per-organisation and SUPER-ADMIN controlled
    // (`Organization.maxWorkspaces`, default 2) — it used to be a hardcoded
    // constant, which meant no org could ever be granted more without a deploy.
    //
    // Checked INSIDE the transaction against a locked organisation row. The
    // previous version counted outside the transaction, so two admins creating
    // a workspace at the same moment could both see `count < max` and both
    // insert, leaving the org permanently one over its cap. `FOR UPDATE`
    // serialises them so the loser re-reads and is correctly refused.
    const workspace = await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ maxWorkspaces: number }[]>`
        SELECT "maxWorkspaces" FROM "Organization"
        WHERE id = ${session.organizationId} FOR UPDATE
      `;
      const maxWorkspaces = locked[0]?.maxWorkspaces ?? 2;
      const count = await tx.workspace.count({
        where: { organizationId: session.organizationId },
      });
      if (count >= maxWorkspaces) {
        throw new BadRequestException({
          error: "workspace_limit_reached",
          detail: `This organization can hold at most ${maxWorkspaces} workspace${maxWorkspaces === 1 ? "" : "s"}. Ask your platform administrator to raise the limit.`,
        });
      }
      return provisionWorkspace(tx, {
        organizationId: session.organizationId,
        name,
        founderUserId: session.userId,
      });
    });
    // The session snapshot carries the membership list the switcher renders —
    // without this bust, the new workspace is invisible for up to 15s and the
    // page that just created it would show nothing.
    invalidateSessionCache(session.userId);
    return workspace;
  }

  async rename(
    session: ApiSession,
    workspaceId: string,
    name: string,
  ): Promise<{ id: string; name: string }> {
    this.assertCanManage(session);
    await this.assertInOrg(session, workspaceId);
    const workspace = await this.db.workspace.update({
      where: { id: workspaceId },
      data: { name },
      select: { id: true, name: true },
    });
    invalidateSessionCache(session.userId);
    return workspace;
  }

  /**
   * Add someone to a workspace, change their role in it, or remove them
   * (`role: null`).
   *
   * Two guards that matter more than the CRUD:
   *   - the target must belong to the SAME organization, or a crafted id would
   *     grant a stranger access to this org's conversations;
   *   - a workspace can never be left with zero admins. Removing the last one
   *     leaves nobody able to configure channels, invite members or undo the
   *     mistake — an unrecoverable state reachable by one careless click.
   *
   * REMOVAL is not just the row: `detachMemberFromWorkspace` re-homes their open
   * conversations and tickets and drops every grant this workspace held for
   * them. Deleting only the membership left work owned by someone who cannot
   * open the workspace — absent from the Unassigned queue and therefore owned by
   * nobody in practice.
   */
  async setMembership(
    session: ApiSession,
    workspaceId: string,
    userId: string,
    role: "admin" | "manager" | "agent" | null,
  ): Promise<void> {
    this.assertCanManage(session);
    await this.assertInOrg(session, workspaceId);

    const target = await this.db.user.findFirst({
      where: { id: userId, organizationId: session.organizationId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException({ error: "user_not_found" });

    const existing = await this.db.workspaceMember.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { role: true },
    });

    // Seat cap on the DIRECT add path. It was enforced only at invite-accept,
    // while the invite flow's own conflict message tells admins to add an
    // existing org user "from Organization → Members instead" — i.e. it
    // routed them at the uncapped door, making the superadmin-controlled
    // `maxMembers` meaningless for any org with more than one workspace.
    // Same locked-row shape as accept: `FOR UPDATE` serializes two concurrent
    // adds onto the last seat. Only a NEW membership consumes a seat — a
    // re-role of an existing member must never be blocked by the cap.
    if (role !== null && !existing) {
      await this.db.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ maxMembers: number }[]>`
          SELECT "maxMembers" FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE
        `;
        const maxMembers = locked[0]?.maxMembers ?? 2;
        const memberCount = await tx.workspaceMember.count({
          where: { workspaceId, user: { deactivatedAt: null, isSuperAdmin: false } },
        });
        if (memberCount >= maxMembers) {
          throw new BadRequestException({
            error: "workspace_full",
            detail: `This workspace has reached its member limit (${maxMembers} member${maxMembers === 1 ? "" : "s"}). Ask the organization's admin to request a higher limit.`,
          });
        }
        await tx.workspaceMember.create({ data: { userId, workspaceId, role } });
        // Same transaction as the membership: a member who exists but isn't in
        // #general has an empty channel sidebar, dead workspace-wide chat
        // search, and a `/team` redirect loop once anyone DMs them. See
        // `joinDefaultChannel` — this path was the one that didn't do it.
        await joinDefaultChannel(tx, workspaceId, userId, session.userId);
      });
      invalidateSessionCache(userId);
      this.sessionInvalidator.revoke(userId, "workspace-membership-added");
      return;
    }

    const applyWrite = async (client: Prisma.TransactionClient | DbService) => {
      if (role === null) {
        await client.workspaceMember.deleteMany({ where: { userId, workspaceId } });
      } else {
        await client.workspaceMember.upsert({
          where: { userId_workspaceId: { userId, workspaceId } },
          create: { userId, workspaceId, role },
          update: { role },
        });
      }
    };

    // Losing the last admin: block whether it happens by removal or by a
    // demotion to manager/agent. Serialize the re-count + write under a
    // `SELECT … FOR UPDATE` on the workspace row — otherwise two concurrent
    // demotions each see `admins = 2 (> 1)` and both commit, leaving the
    // workspace with ZERO admins (its own comment calls that unrecoverable).
    // Same TOCTOU pattern the create-cap and UsersService guards already use.
    if (existing?.role === "admin" && role !== "admin") {
      await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`;
        const admins = await tx.workspaceMember.count({
          where: { workspaceId, role: "admin" },
        });
        if (admins <= 1) {
          throw new BadRequestException({
            error: "last_admin",
            detail:
              "This is the workspace's only admin. Promote someone else first — a workspace with no admin can't be configured or repaired.",
          });
        }
        await applyWrite(tx);
      });
    } else {
      await applyWrite(this.db);
    }
    // The TARGET's session carries their membership set + effective role, so
    // theirs is the state that must drop — not the actor's. `revoke`, not just
    // a cache bust: a cache bust alone fixed the next HTTP request but left
    // the member's LIVE SOCKETS joined to `ws:<id>` and every conv room — a
    // removed agent's open tab kept the full team firehose (message bodies,
    // contact PII) until it happened to reconnect. Workspaces are the hard
    // isolation boundary; the disconnect forces a re-handshake that resolves
    // against the new membership (and re-derives the role for a demotion).
    this.sessionInvalidator.revoke(
      userId,
      role === null ? "workspace-removal" : "workspace-role-change",
    );

    // Detach the work and the grants. Detached + best-effort ON PURPOSE, exactly
    // like the deactivation path: the membership write has committed and is what
    // the caller is waiting on. Anything that fails to re-home stays visible in
    // the workspace inbox, and the removed member is already excluded from every
    // candidate pool (which filters on WorkspaceMember).
    if (role === null && existing) {
      void detachMemberFromWorkspace(this.db, workspaceId, userId, {
        rebalance: true,
        // They are gone from this workspace for good — take the grants with
        // them (policy seat, channel memberships, personal views, pointers).
        clearGrants: true,
        // They can never open this workspace again, so a thread left on them is
        // invisible work. Unassigned is strictly better. (Deactivation reasons
        // the opposite way — see the option's comment.)
        unassignWhenNoCandidate: true,
      })
        .then(({ conversationsMoved, ticketsMoved }) => {
          if (conversationsMoved > 0 || ticketsMoved > 0) {
            this.logger.log(
              `removed ${userId} from workspace ${workspaceId}: re-homed ${conversationsMoved} conversation(s), ${ticketsMoved} ticket(s)`,
            );
          }
        })
        .catch((err) => {
          this.logger.warn(
            `detach-on-remove failed for ${userId} in ${workspaceId}: ${err instanceof Error ? err.message : err}`,
          );
        });
    }
  }

  /**
   * Delete a workspace and everything in it.
   *
   * This is the most destructive action in the product: the FK cascade takes
   * the workspace's contacts, conversations, messages, tickets, broadcasts and
   * channel connections with it. There is no undo and no soft-delete tombstone,
   * so three guards stand in front of it:
   *
   *   1. org owner/admin only,
   *   2. it must belong to THIS org,
   *   3. an organization can never be left with ZERO workspaces — that state
   *      has no UI to recover from (every screen is workspace-scoped), so the
   *      last one is undeletable by construction rather than by convention.
   *
   * The caller is expected to have taken a typed confirmation; this is the
   * backstop, not the prompt.
   */
  async remove(session: ApiSession, workspaceId: string): Promise<void> {
    this.assertCanManage(session);
    await this.assertInOrg(session, workspaceId);

    // Serialize the count + delete under a `SELECT … FOR UPDATE` on the ORG
    // row (the invariant is org-level: "keep ≥1 workspace"). Without it, two
    // concurrent deletes of the last two workspaces each see `remaining = 2
    // (> 1)` and both commit, leaving the org with ZERO workspaces — nothing to
    // open. Members are collected inside the tx BEFORE the cascade removes
    // their WorkspaceMember rows, so we still know whose session went stale.
    const members = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${session.organizationId} FOR UPDATE`;
      const remaining = await tx.workspace.count({
        where: { organizationId: session.organizationId },
      });
      if (remaining <= 1) {
        throw new BadRequestException({
          error: "last_workspace",
          detail:
            "An organization must keep at least one workspace — every screen in the app is scoped to one, so deleting the last leaves nothing to open.",
        });
      }
      const m = await tx.workspaceMember.findMany({
        where: { workspaceId },
        select: { userId: true },
      });
      return m;
    });

    // THE DELETE ITSELF IS DELEGATED. This method used to run its own
    // `tx.workspace.delete` inside the org-lock transaction above, which was a
    // second, unsafe implementation of a job `WorkspaceRootService.destroy`
    // already does properly:
    //
    //   - it pre-drains `Message` in batches, because a single cascade deletes
    //     them all in ONE transaction — a lock storm + WAL blowup that can
    //     wedge the database on a workspace with real history. Worse, running
    //     it inside the interactive transaction above meant it ALSO held the
    //     org row lock, so a slow delete blocked every other org-level write
    //     (workspace create, member add, user delete) and then failed on
    //     Prisma's 5s interactive-transaction timeout;
    //   - it snapshots and deletes the R2 blobs (message media, thumbnails,
    //     member and contact avatars) before the rows vanish. Nothing else can
    //     reclaim them: the orphan sweeper deliberately skips `avatars/`;
    //   - it busts the provider-credential cache, which otherwise keeps a
    //     deleted workspace's channel config live for up to its TTL;
    //   - it kicks the members' sockets.
    //
    // The org-lock transaction above stays: it is what makes the
    // "an org must keep one workspace" check race-safe. Only the destruction
    // moved out of it.
    await this.workspaceRoot.destroy(workspaceId, "workspace-delete");

    // `Session.activeWorkspaceId` has no FK (a per-device preference, not a
    // relation), so it survives the cascade pointing at a dead id. Clear it or
    // the member's next request resolves a workspace that no longer exists
    // instead of falling through to their first remaining membership.
    await this.db.session.updateMany({
      where: { activeWorkspaceId: workspaceId },
      data: { activeWorkspaceId: null },
    });
    // Every member of the deleted workspace holds a stale membership list.
    for (const m of members) invalidateSessionCache(m.userId);
  }

  /** Org owners and admins manage the directory; a platform superAdmin always can. */
  private isOrgManager(session: ApiSession): boolean {
    return (
      session.isSuperAdmin || session.orgRole === "owner" || session.orgRole === "admin"
    );
  }

  private assertCanManage(session: ApiSession): void {
    if (!this.isOrgManager(session)) {
      throw new ForbiddenException({ error: "org_admin_required" });
    }
  }

  /** Tenant boundary: an id from another org must not be addressable. */
  private async assertInOrg(session: ApiSession, workspaceId: string): Promise<void> {
    const found = await this.db.workspace.count({
      where: { id: workspaceId, organizationId: session.organizationId },
    });
    if (!found) throw new NotFoundException({ error: "workspace_not_found" });
  }

  private async canAccess(session: ApiSession, workspaceId: string): Promise<boolean> {
    // The beyond-membership escape is THE shared rule
    // (`@ccp/shared/auth/active-workspace`) — the same one the HTTP guard, the
    // socket handshake and the RSC session apply, so the switch endpoint can
    // never accept a workspace those resolvers will refuse (or vice versa).
    // Membership set is EMPTY here on purpose: this method re-validates
    // membership against the database below rather than trusting the session
    // snapshot — a membership revoked moments ago must not stay switchable for
    // the cache window.
    const beyond = makeCanAccessBeyondMembership({
      isSuperAdmin: session.isSuperAdmin,
      isOrgAdmin: session.orgRole === "owner" || session.orgRole === "admin",
      organizationId: session.organizationId,
      memberWorkspaceIds: new Set<string>(),
      countWorkspaces: (where) => this.db.workspace.count({ where }),
    });
    if (await beyond(workspaceId)) return true;
    const membership = await this.db.workspaceMember.count({
      where: { userId: session.userId, workspaceId },
    });
    return membership > 0;
  }
}

// ---------------------------------------------------------------------------
// Organization surface.
// ---------------------------------------------------------------------------

export interface OrganizationOverview {
  id: string;
  name: string;
  plan: string;
  status: string;
  workspaces: Array<{
    id: string;
    name: string;
    memberCount: number;
    conversationCount: number;
    channelAccountCount: number;
    /** Whether the REQUESTING user can open this one. */
    joined: boolean;
    createdAt: string;
  }>;
  members: Array<{
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    orgRole: string;
    isActive: boolean;
    memberships: Array<{ workspaceId: string; role: string }>;
  }>;
  /** Whether the requesting user may create / rename / grant. */
  canManage: boolean;
}
