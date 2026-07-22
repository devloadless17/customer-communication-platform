import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { provisionWorkspace } from "@/lib/workspaces/provision";

import { invalidateSessionCache, type ApiSession } from "../auth/session.guard";
import { DbService } from "../db/db.service";

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
}

@Injectable()
export class WorkspacesService {
  constructor(private readonly db: DbService) {}

  /**
   * The workspaces this user may act in, for the switcher. Read straight off
   * the session — `resolveSession` already loaded the membership set, so the
   * switcher costs ZERO extra queries on every render.
   */
  list(session: ApiSession): WorkspaceSummary[] {
    return session.workspaceMemberships.map((m) => ({
      id: m.workspaceId,
      name: m.name,
      role: m.role,
      isActive: m.workspaceId === session.workspaceId,
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

    // Losing the last admin: block whether it happens by removal or by a
    // demotion to manager/agent.
    if (existing?.role === "admin" && role !== "admin") {
      const admins = await this.db.workspaceMember.count({
        where: { workspaceId, role: "admin" },
      });
      if (admins <= 1) {
        throw new BadRequestException({
          error: "last_admin",
          detail:
            "This is the workspace's only admin. Promote someone else first — a workspace with no admin can't be configured or repaired.",
        });
      }
    }

    if (role === null) {
      await this.db.workspaceMember.deleteMany({ where: { userId, workspaceId } });
    } else {
      await this.db.workspaceMember.upsert({
        where: { userId_workspaceId: { userId, workspaceId } },
        create: { userId, workspaceId, role },
        update: { role },
      });
    }
    // The TARGET's session carries their membership set + effective role, so
    // theirs is the cache that must drop — not the actor's.
    invalidateSessionCache(userId);
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

    const remaining = await this.db.workspace.count({
      where: { organizationId: session.organizationId },
    });
    if (remaining <= 1) {
      throw new BadRequestException({
        error: "last_workspace",
        detail:
          "An organization must keep at least one workspace — every screen in the app is scoped to one, so deleting the last leaves nothing to open.",
      });
    }

    // Collect the members BEFORE the delete — the cascade removes their
    // WorkspaceMember rows, so afterwards there is no way to learn whose
    // session snapshot just went stale.
    const members = await this.db.workspaceMember.findMany({
      where: { workspaceId },
      select: { userId: true },
    });

    await this.db.workspace.delete({ where: { id: workspaceId } });

    // Anyone whose active workspace was this one now points at a row that no
    // longer exists. `Session.activeWorkspaceId` has no FK (it is a per-device
    // preference, not a relation), so clear it explicitly — otherwise their
    // next request resolves a dead id and falls through to an error instead of
    // their first remaining membership.
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
    if (session.isSuperAdmin) {
      const exists = await this.db.workspace.count({ where: { id: workspaceId } });
      return exists > 0;
    }
    if (session.orgRole === "owner" || session.orgRole === "admin") {
      const inOrg = await this.db.workspace.count({
        where: { id: workspaceId, organizationId: session.organizationId },
      });
      return inOrg > 0;
    }
    const membership = await this.db.workspaceMember.count({
      where: { userId: session.userId, workspaceId },
    });
    return membership > 0;
  }
}

// ---------------------------------------------------------------------------
// Organization surface.
// ---------------------------------------------------------------------------

/**
 * How many workspaces one organization may hold.
 *
 * A ceiling exists because a workspace is not free: it seeds rows, holds its
 * own channel connections, and every list query in the app is scoped to one.
 * 50 is far above any real team's need and low enough that a scripted loop
 * can't quietly provision thousands.
 */

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
