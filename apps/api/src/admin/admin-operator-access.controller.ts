import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";

import { setActiveWorkspaceCookie } from "../auth/active-workspace-cookie";
import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import { invalidateSessionCache, type ApiSession } from "../auth/session.guard";
import { zBody, zQuery } from "../common/zod-validation.pipe";
import { DbService } from "../db/db.service";

const EnterWorkspaceSchema = z.object({
  workspaceId: z.string().min(1),
});
type EnterWorkspaceInput = z.infer<typeof EnterWorkspaceSchema>;

const ListAccessSchema = z.object({
  organizationId: z.string().min(1),
});
type ListAccessInput = z.infer<typeof ListAccessSchema>;

/** How many entries the audit panel renders. A log nobody can scan is not a log. */
const ACCESS_LOG_PAGE = 20;

/**
 * OPERATOR MODE — the explicit door into a customer's workspace.
 *
 *   POST /api/admin/operator-access   { workspaceId }   — enter, and record it
 *   GET  /api/admin/operator-access?organizationId=…    — the entry log
 *
 * WHY THIS EXISTS AT ALL. The platform operator owns the box but is an employee
 * of no tenant. Onboarding a client who cannot paste their own Meta credentials,
 * or opening a live workspace to confirm the system is healthy, previously
 * required being invited — one mailbox and one seat per organization. The
 * operator branch of `makeCanAccessBeyondMembership`
 * (packages/shared/src/auth/active-workspace.ts) grants the reach; this route is
 * what makes it an ACTION rather than an ambient capability, and it is the only
 * thing that writes the log.
 *
 * WHAT IT IS NOT. It is not a gate — read the resolver's branch comment. A
 * superAdmin who hand-sets `ccp.ws` gets in without passing through here and
 * without a row. The log records intent; the flag is what enforces. That is a
 * deliberate, single-operator tradeoff, written down in three places so it
 * cannot be mistaken for an oversight.
 *
 * The operator never becomes a `WorkspaceMember` — that is the whole design.
 * Membership is what every people-surface filters on (assignment pools,
 * availability, seat counts, rosters, mention pickers), so holding no row is
 * precisely what keeps an administrator from being counted as workforce.
 */
@Controller("api/admin/operator-access")
@RequireRole("superAdmin")
export class AdminOperatorAccessController {
  constructor(private readonly db: DbService) {}

  /**
   * Enter a customer's workspace: record it, then point this device at it.
   *
   * Ordering is load-bearing. The `OperatorAccess` row is written BEFORE the
   * session and the cookie, so a failed insert fails the ENTRY rather than
   * granting an unlogged one. This is the opposite of the notification
   * convention (`notifyUsers` swallows its own failure so a courtesy can't fail
   * a real write) — here the record IS the accountability, so it goes first and
   * its failure is the caller's problem.
   *
   * The tail then mirrors `WorkspacesService.setActive` exactly: durable choice
   * on the Session row, cache bust, cookie. Anything less and the operator lands
   * in a workspace for one request and falls back to their own on the next.
   */
  @Post()
  async enter(
    @CurrentSession() session: ApiSession,
    @Body(zBody(EnterWorkspaceSchema)) body: EnterWorkspaceInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    // The platform anchor is not a tenant — 404 it exactly as the sibling admin
    // controllers do. The operator reaches their OWN workspaces through the
    // ordinary switcher, where they are a real member; routing that through the
    // operator door would write audit rows about visiting themselves.
    const workspace = await this.db.workspace.findFirst({
      where: { id: body.workspaceId, organization: { isPlatform: false } },
      select: {
        id: true,
        name: true,
        organizationId: true,
        organization: { select: { name: true } },
      },
    });
    if (!workspace) throw new NotFoundException({ error: "workspace_not_found" });

    await this.db.operatorAccess.create({
      data: {
        userId: session.userId,
        organizationId: workspace.organizationId,
        enteredWorkspaceId: workspace.id,
      },
    });

    await this.db.session.update({
      where: { id: session.sessionId },
      data: { activeWorkspaceId: workspace.id },
    });
    // Without this the 15s snapshot keeps serving the operator's PREVIOUS
    // workspace, and the hard navigation that follows renders the old one.
    invalidateSessionCache(session.userId);
    setActiveWorkspaceCookie(res, workspace.id);

    return {
      ok: true,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      organizationName: workspace.organization.name,
    };
  }

  /**
   * The entry log for one organization, newest first — what the platform org
   * page renders under "Operator access".
   *
   * Org-keyed rather than platform-wide because the question people actually
   * ask is "was this tenant entered, and when", asked while looking at that
   * tenant. `userId` is a plain id (no relation — see the model), so the
   * operator's name is resolved in a second, tiny query rather than a join.
   */
  @Get()
  async list(@Query(zQuery(ListAccessSchema)) query: ListAccessInput) {
    const rows = await this.db.operatorAccess.findMany({
      where: { organizationId: query.organizationId },
      orderBy: { createdAt: "desc" },
      take: ACCESS_LOG_PAGE,
      select: {
        id: true,
        userId: true,
        enteredWorkspaceId: true,
        createdAt: true,
      },
    });
    if (rows.length === 0) return { entries: [] };

    const [operators, workspaces] = await Promise.all([
      this.db.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
        select: { id: true, name: true, email: true },
      }),
      this.db.workspace.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.enteredWorkspaceId))] } },
        select: { id: true, name: true },
      }),
    ]);
    const operatorById = new Map(operators.map((u) => [u.id, u]));
    const workspaceById = new Map(workspaces.map((w) => [w.id, w.name]));

    return {
      entries: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        // Null when the account or the workspace has since been deleted — both
        // are plain ids on purpose, so the visit outlives what it visited.
        operatorName: operatorById.get(r.userId)?.name ?? null,
        operatorEmail: operatorById.get(r.userId)?.email ?? null,
        workspaceId: r.enteredWorkspaceId,
        workspaceName: workspaceById.get(r.enteredWorkspaceId) ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}
