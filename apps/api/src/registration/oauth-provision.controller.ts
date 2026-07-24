import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { zBody } from "../common/zod-validation.pipe";
import { DbService } from "../db/db.service";
import { invalidateSuperAdminAggregates } from "@/lib/queries";

import { provisionWorkspace } from "@/lib/workspaces/provision";

/**
 * POST /api/internal/provision-oauth-user
 *
 * Provision a tenant for someone arriving via Google for the first time, in
 * TWO phases — because Better Auth insists on creating the `User` row itself.
 *
 * WHY TWO PHASES. `User.organizationId` is required with no default, so Better
 * Auth's auto-create has nothing to attach the row to. The obvious fix — have
 * the `before` hook create everything and return `false` to suppress Better
 * Auth's insert — DOES NOT WORK: `false` aborts the sign-in and surfaces as
 * `unable_to_create_user`, because Better Auth treats a suppressed create as a
 * failed one. (That was the first implementation, and this comment exists so
 * nobody tries it again.)
 *
 *   POST …/oauth-org        — before hook. Creates the Organization ONLY and
 *                             returns its id, which the hook injects into the
 *                             user data so Better Auth's own insert succeeds.
 *   POST …/oauth-workspace  — after hook. Now that a userId exists, seeds the
 *                             Workspace (stages, #general, founder membership).
 *
 * The split is forced by an ordering constraint, not chosen: `provisionWorkspace`
 * needs the founder's id for the membership row, the team-chat channel and its
 * creator — none of which exist until Better Auth has written the user.
 *
 * AUTH: the shared `INTERNAL_BUS_SECRET` header, timing-safe compared, same as
 * the session-invalidation bus. This endpoint CREATES USERS, so it must never
 * be reachable from outside — Caddy does not route `/api/internal/*` and the
 * secret is the second line. Without both, this is an open account factory.
 */

const OrgSchema = z.object({
  name: z.string().trim().min(1).max(200),
});
type OrgInput = z.infer<typeof OrgSchema>;

const WorkspaceSchema = z.object({
  organizationId: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().trim().min(1).max(200),
});
type WorkspaceInput = z.infer<typeof WorkspaceSchema>;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.byteLength !== bb.byteLength) return false;
  return timingSafeEqual(ab, bb);
}

@Controller("api/internal")
export class OAuthProvisionController {
  private readonly logger = new Logger(OAuthProvisionController.name);

  constructor(private readonly db: DbService) {}

  private assertInternal(req: Request): void {
    const expected = process.env.INTERNAL_BUS_SECRET;
    const provided = req.header("x-internal-secret");
    if (!expected || !provided || !safeEqual(provided, expected)) {
      throw new UnauthorizedException({ error: "unauthorized" });
    }
  }

  /**
   * PHASE 1 — the Organization, and nothing else.
   *
   * `status: pending` (the column default, spelled out): the tenant exists but
   * is locked out until a super-admin approves it, which is what makes an
   * abandoned OAuth signup harmless.
   */
  @Post("provision-oauth-org")
  @HttpCode(200)
  async provisionOrg(@Req() req: Request, @Body(zBody(OrgSchema)) body: OrgInput) {
    this.assertInternal(req);
    const organization = await this.db.organization.create({
      // Named from the person until they rename it. A Google profile carries no
      // company name, and asking mid-handshake would mean holding a
      // half-finished OAuth state across a form submission.
      data: { name: `${body.name}'s organization`, status: "pending" },
      select: { id: true },
    });
    return { ok: true as const, organizationId: organization.id };
  }

  /**
   * PHASE 2 — the Workspace, now that a founder exists.
   *
   * Idempotent on re-entry: if the org already has a workspace (a retried
   * callback, a double-submitted consent screen) this returns the existing one
   * rather than seeding a second #general and a duplicate stage set.
   */
  @Post("provision-oauth-workspace")
  @HttpCode(200)
  async provisionWorkspaceForOauth(
    @Req() req: Request,
    @Body(zBody(WorkspaceSchema)) body: WorkspaceInput,
  ) {
    this.assertInternal(req);

    const existing = await this.db.workspace.findFirst({
      where: { organizationId: body.organizationId },
      select: { id: true },
    });
    if (existing) return { ok: true as const, workspaceId: existing.id };

    try {
      const workspace = await this.db.$transaction((tx) =>
        provisionWorkspace(tx, {
          organizationId: body.organizationId,
          name: `${body.name}'s workspace`,
          founderUserId: body.userId,
        }),
      );
      // A brand-new org lands in the approval queue — the one list an operator
      // watches. It must not wait out the 60s memo TTL to appear.
      invalidateSuperAdminAggregates();
      return { ok: true as const, workspaceId: workspace.id };
    } catch (err) {
      // A user with an org but no workspace 500s on every page. Log loudly —
      // this is the one state this flow can leave behind, and it is repairable
      // only by hand.
      this.logger.error(
        `OAuth workspace provisioning FAILED for org=${body.organizationId} ` +
          `user=${body.userId}: ${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
  }
}
