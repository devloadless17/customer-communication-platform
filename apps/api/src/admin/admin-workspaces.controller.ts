import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
} from "@nestjs/common";
import { z } from "zod";

import {
  getWorkspaceDetailForSuperAdmin,
  listAllOrgsForSuperAdmin,
  listAllWorkspacesForSuperAdmin,
} from "@/lib/queries";

import { RequireRole } from "../auth/role.guard";
import { zBody } from "../common/zod-validation.pipe";
import { DbService } from "../db/db.service";

// Per-WORKSPACE seat cap. Min 1 (a workspace always has at least its founder);
// a generous upper bound keeps a typo from creating a nonsensical value.
// Default is 2 on the Workspace row — this only raises/lowers it.
const SetMaxMembersSchema = z.object({
  maxMembers: z.number().int().min(1).max(1000),
});
type SetMaxMembersInput = z.infer<typeof SetMaxMembersSchema>;

// Per-ORGANISATION workspace cap. Min 1 — an org with zero workspaces has
// nowhere to work, and the signup flow provisions one immediately.
const SetMaxWorkspacesSchema = z.object({
  maxWorkspaces: z.number().int().min(1).max(100),
});
type SetMaxWorkspacesInput = z.infer<typeof SetMaxWorkspacesSchema>;

/**
 * superAdmin cross-team admin surface — the WORKSPACE-keyed half.
 *
 *   GET    /api/admin/workspaces                   — every workspace + counts
 *   GET    /api/admin/workspaces/:id               — one workspace's detail
 *   PATCH  /api/admin/workspaces/:id/max-members   — seat cap for THIS workspace
 *   PATCH  /api/admin/workspaces/:id/max-workspaces— how many the owning ORG may have
 *
 * Anything that acts on the ORGANISATION (approve / suspend / delete) lives in
 * `admin-organizations.controller.ts` and is keyed by the organisation id. The
 * two used to be mixed here, org-level writes reached through a workspace id,
 * and that cost twice: the self-guards compared the wrong id (an operator could
 * suspend or delete their own org via a sibling workspace), and an org with no
 * workspaces had no id to address it by, so it could not be approved or deleted
 * at all. Keep each write keyed by the thing it actually mutates.
 *
 * Visibility ends at aggregate counts + the member roster — never customer
 * message bodies or contact names (see super-admin.ts query comment).
 */
@Controller("api/admin/workspaces")
@RequireRole("superAdmin")
export class AdminWorkspacesController {
  constructor(
    private readonly db: DbService,
  ) {}

  /**
   * Platform roster, ORGANISATION-first with each org's workspaces nested.
   *
   * `teams` is still returned (flat workspace list) so nothing that consumed
   * the old shape breaks; `orgs` is what the platform page renders.
   */
  @Get()
  async list() {
    const [workspaces, orgs] = await Promise.all([
      listAllWorkspacesForSuperAdmin(),
      listAllOrgsForSuperAdmin(),
    ]);
    return { workspaces, orgs };
  }

  @Get(":id")
  async get(@Param("id") workspaceId: string) {
    const detail = await getWorkspaceDetailForSuperAdmin(workspaceId);
    if (!detail) throw new NotFoundException({ error: "workspace_not_found" });
    return detail;
  }

  /**
   * Set an org's member cap (default 2). Lowering it below the current active
   * count is allowed — existing members are grandfathered; the cap only blocks
   * NEW joins (invite-accept enforces it). Returns the current active count so
   * the UI can warn when the new cap is already met/exceeded.
   *
   *   PATCH /api/admin/workspaces/:id/max-members   { maxMembers }
   */
  @Patch(":id/max-members")
  async setMaxMembers(
    @Param("id") workspaceId: string,
    @Body(zBody(SetMaxMembersSchema)) body: SetMaxMembersInput,
  ) {
    // No self-team guard here (unlike setStatus/remove): a member cap is NOT a
    // lockout. superAdmins don't count as seats (see the count below), so an
    // operator capping their own org can't lock anyone out, and it's trivially
    // reversible by raising it again. Guarding it added zero safety and only
    // created a UI/server mismatch — the platform org-detail "Limit" control is
    // rendered for every org including the operator's own.
    // The seat cap is a WORKSPACE-level fact: a member holds a seat in a
    // workspace, not in the organisation as a whole.
    // The anchor is not a tenant — 404 it here exactly as the org-side sibling
    // does via `assertExists`. The same operation reachable by two ids must not
    // behave differently depending on which id you use.
    const updated = await this.db.workspace.updateMany({
      where: { id: workspaceId, organization: { isPlatform: false } },
      data: { maxMembers: body.maxMembers },
    });
    if (updated.count === 0) {
      throw new NotFoundException({ error: "workspace_not_found" });
    }
    const activeMembers = await this.db.user.count({
      where: { workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null, isSuperAdmin: false },
    });
    return { ok: true, maxMembers: body.maxMembers, activeMembers };
  }

  /**
   * Raise/lower how many WORKSPACES an organisation may create.
   *
   *   PATCH /api/admin/workspaces/:id/max-workspaces   { maxWorkspaces }
   *
   * Addressed by a workspace id like the sibling routes (the platform detail
   * page is workspace-keyed), but writes the ORGANISATION that owns it.
   *
   * Deliberately NOT retroactive: setting a cap below the number of workspaces
   * an org already has does not delete any. It only refuses the next `create`.
   * Destroying a workspace full of conversations because someone typed a small
   * number into an admin box would be indefensible.
   */
  @Patch(":id/max-workspaces")
  async setMaxWorkspaces(
    @Param("id") workspaceId: string,
    @Body(zBody(SetMaxWorkspacesSchema)) body: SetMaxWorkspacesInput,
  ) {
    const updated = await this.db.organization.updateMany({
      where: { isPlatform: false, workspaces: { some: { id: workspaceId } } },
      data: { maxWorkspaces: body.maxWorkspaces },
    });
    if (updated.count === 0) {
      throw new NotFoundException({ error: "workspace_not_found" });
    }
    const workspace = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { organizationId: true },
    });
    const workspaceCount = workspace
      ? await this.db.workspace.count({
          where: { organizationId: workspace.organizationId },
        })
      : 0;
    return { ok: true, maxWorkspaces: body.maxWorkspaces, workspaceCount };
  }

}
