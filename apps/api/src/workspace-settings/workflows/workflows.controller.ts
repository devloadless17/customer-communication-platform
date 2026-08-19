import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import { SessionGuard } from "../../auth/session.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import {
  ListWorkflowRunsQuerySchema,
  ManualTriggerSchema,
  PublishWorkflowSchema,
  TestWorkflowSchema,
  type ListWorkflowRunsQuery,
  type ManualTriggerInput,
  type PublishWorkflowInput,
  type TestWorkflowInput,
} from "./workflows.schemas";
import { WorkflowsService } from "./workflows.service";

/**
 * Workflow CRUD + triggers + runs.
 *
 * Guards are per-method because the route mix splits across:
 *   - admin (most routes — index, CRUD, publish, test, runs)
 *   - any agent (manual-trigger — the inbox "Run workflow" menu)
 *
 * The public HMAC-gated incoming-webhook endpoint lives in a SEPARATE
 * controller (no guards at all) to keep this controller's auth surface
 * uniform and admin-leaning.
 *
 * Route order: static sub-paths (`publish`, `manual-trigger`, `test`,
 * `runs`) precede `:id` to avoid swallowing — Express matches in
 * registration order.
 */
@Controller("api/workspace/workflows")
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  // ---- Index --------------------------------------------------------------

  @Get()
  @RequireRole("admin")
  async list(@CurrentSession() session: ApiSession) {
    return this.workflows.list(session.workspaceId);
  }

  @Post()
  @RequireRole("admin")
  async create(@CurrentSession() session: ApiSession, @Body() body: unknown) {
    // Body is intentionally `unknown` — the workflow document is too
    // recursive (nodes / edges / per-step config) to express cleanly in
    // Zod here. parseWorkflowBody in lib/workflows/parse.ts owns the deep
    // validation and the service throws BadRequestException with
    // `{ error, details, stepErrors }`. Note: the error envelope differs
    // from zBody's `{ error, issues }` — clients of this endpoint must
    // read `details` rather than `issues`.
    return this.workflows.create(session.workspaceId, body);
  }

  // ---- :id sub-paths (must precede :id leaf) -----------------------------

  @Post(":id/publish")
  @RequireRole("admin")
  async publish(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(PublishWorkflowSchema)) body: PublishWorkflowInput,
  ) {
    const out = await this.workflows.publish(
      session.workspaceId,
      id,
      body.publish,
    );
    return { ok: true, ...out };
  }

  /**
   * Manual trigger — any agent (not admin-only). The workflow itself must
   * be `trigger=manual_trigger` for the call to succeed, and the caller's
   * workspace role must satisfy `triggerConfig.allowedRoles` when the author
   * set one; the service enforces both.
   */
  @Post(":id/manual-trigger")
  @UseGuards(SessionGuard)
  async manualTrigger(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(ManualTriggerSchema)) body: ManualTriggerInput,
  ) {
    const out = await this.workflows.manualTrigger(
      session.workspaceId,
      session.userId,
      id,
      body,
      session.role,
    );
    return { ok: true, ...out };
  }

  @Post(":id/test")
  @RequireRole("admin")
  async test(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(TestWorkflowSchema)) body: TestWorkflowInput,
  ) {
    const out = await this.workflows.test(session.workspaceId, id, body);
    return { ok: true, ...out };
  }

  @Get(":id/runs")
  @RequireRole("admin")
  async listRuns(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Query(zQuery(ListWorkflowRunsQuerySchema)) query: ListWorkflowRunsQuery,
  ) {
    return this.workflows.listRuns(session.workspaceId, id, query);
  }

  @Get(":id/runs/:runId")
  @RequireRole("admin")
  async getRun(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Param("runId") runId: string,
  ) {
    return this.workflows.getRun(session.workspaceId, id, runId);
  }

  // ---- :id leaf ----------------------------------------------------------

  @Get(":id")
  @RequireRole("admin")
  async get(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    return this.workflows.get(session.workspaceId, id);
  }

  @Patch(":id")
  @RequireRole("admin")
  async update(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    // Same `unknown` rationale as create() above — parseWorkflowBody owns
    // the deep validation; errors come back as `{ details, stepErrors }`.
    return this.workflows.update(session.workspaceId, id, body);
  }

  @Delete(":id")
  @RequireRole("admin")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.workflows.remove(session.workspaceId, id);
    return { ok: true };
  }
}
