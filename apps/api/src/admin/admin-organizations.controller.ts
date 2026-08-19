import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  NotFoundException,
  Param,
  Patch,
} from "@nestjs/common";
import { z } from "zod";

import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import { SessionInvalidationService } from "../auth/session-invalidation.service";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { DbService } from "../db/db.service";
import { WorkspaceRootService } from "../workspace-settings/workspace-root.service";
import { invalidateSuperAdminAggregates } from "@/lib/queries";

const SetStatusSchema = z.object({
  status: z.enum(["pending", "active", "suspended"]),
  reason: z.string().trim().max(500).optional(),
});
type SetStatusInput = z.infer<typeof SetStatusSchema>;

/**
 * superAdmin actions keyed by ORGANISATION id.
 *
 *   PATCH  /api/admin/organizations/:id/status — approve / suspend / reactivate
 *   DELETE /api/admin/organizations/:id        — hard-delete the whole tenant
 *
 * The sibling `/api/admin/workspaces/:id` routes do the same two things but are
 * keyed by a WORKSPACE id, which strands any organisation that has none. That
 * is not hypothetical: social signup provisions the Organization before the
 * User (`User.organizationId` is required with no default), so a failed user
 * insert leaves a real, `pending`, zero-workspace org — and the platform list
 * renders it while every action on the row is gated behind `workspaces[0]`.
 * It could be seen but never approved, never opened, never deleted, and it went
 * on holding its founder's globally-unique email.
 *
 * These routes take the id the org actually has. The workspace-keyed pair stays
 * for the detail page, which is legitimately reached through a workspace.
 */
@Controller("api/admin/organizations")
@RequireRole("superAdmin")
export class AdminOrganizationsController {
  constructor(
    private readonly db: DbService,
    private readonly workspaceRoot: WorkspaceRootService,
    private readonly sessionInvalidator: SessionInvalidationService,
  ) {}

  /** Refuse to act on the operator's own tenant — same rule as the workspace-keyed pair. */
  private assertNotOwnOrg(organizationId: string, session: ApiSession, action: string): void {
    if (organizationId === session.organizationId) {
      throw new BadRequestException({
        error: "cannot_act_on_own_organization",
        detail: `Cannot ${action} your own organization.`,
      });
    }
  }

  /**
   * The organization exists AND is a customer.
   *
   * The platform's own anchor org (see `Organization.isPlatform`) is filtered
   * out of every console list, so it is not reachable through the UI — but this
   * is the API, and an id typed by hand must not be either. Suspending it would
   * lock the operator out of the console they suspend FROM, and deleting it
   * cascades the operator's own user row.
   *
   * 404, not 403: the anchor is not a tenant, so from this endpoint's point of
   * view there is no such organization.
   */
  private async assertExists(organizationId: string): Promise<void> {
    const org = await this.db.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, isPlatform: true },
    });
    if (!org || org.isPlatform) {
      throw new NotFoundException({ error: "organization_not_found" });
    }
  }

  @Patch(":id/status")
  async setStatus(
    @CurrentSession() session: ApiSession,
    @Param("id") organizationId: string,
    @Body(zBody(SetStatusSchema)) body: SetStatusInput,
  ) {
    await this.assertExists(organizationId);
    this.assertNotOwnOrg(organizationId, session, "change the status of");

    await this.db.organization.update({
      where: { id: organizationId },
      data: {
        status: body.status,
        // Reason is only meaningful while suspended; clear it on (re)activation.
        statusReason: body.status === "suspended" ? body.reason ?? null : null,
        statusUpdatedAt: new Date(),
        statusUpdatedById: session.userId,
      },
    });

    // Land the change immediately for every member of the target org (theirs,
    // not the operator's, so the operator's own session is untouched). Selected
    // by `organizationId` — the workspace-keyed predecessor used
    // `workspaceMemberships.some`, which silently skipped any member who had
    // not joined a workspace yet.
    const members = await this.db.user.findMany({
      where: { organizationId },
      select: { id: true },
    });

    if (body.status === "suspended") {
      // A suspend is a hard access-cut (non-payment / abuse / TOS), so it must
      // drop LIVE connections — busting the 15s cache alone only gates the next
      // HTTP request and leaves any already-open Socket.io tab streaming the
      // org's inbound WhatsApp + realtime team data until it reconnects.
      // `revoke` busts the cache AND kicks every socket, and socket-auth's
      // org-status gate refuses any re-handshake. We deliberately do NOT delete
      // the Better Auth Session rows: org suspension ≠ user deactivation. The
      // member is still a valid user whose ORG is suspended, so their persisted
      // session must survive for the (app) layout to render the "/pending →
      // suspended" explanation screen (with statusReason). The SessionGuard
      // 403s every API call and the layout redirects to /pending on that
      // still-valid session — access is fully cut without dumping the member
      // onto a context-free /login. (Deleting sessions added nothing
      // security-wise — the gate already blocks everything — but broke the
      // suspended-org UX; regression caught by platform.spec.ts 2026-06-11.)
      for (const m of members) this.sessionInvalidator.revoke(m.id, "suspension");
    } else {
      // Approve / reactivate: only bust the cache so a re-approved member is let
      // in on their next request without waiting out the TTL — don't needlessly
      // kick their live sockets or force a re-login.
      for (const m of members) this.sessionInvalidator.bustCache(m.id);
    }

    // The roster + overview aggregates are memoized for 60s. An admin who just
    // approved or suspended an org will look straight at that list, so a stale
    // status there would read as "the action didn't work".
    invalidateSuperAdminAggregates();
    return { ok: true as const, status: body.status };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") organizationId: string,
  ) {
    await this.assertExists(organizationId);
    this.assertNotOwnOrg(organizationId, session, "delete");

    await this.workspaceRoot.destroyOrganization(
      organizationId,
      `api/admin/organizations ${organizationId}`,
    );
    invalidateSuperAdminAggregates();
    return { ok: true as const };
  }
}
