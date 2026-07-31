import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import {
  ListWorkflowRunsQuerySchema,
  ManualTriggerSchema,
  PublishWorkflowSchema,
  type ListWorkflowRunsQuery,
  type ManualTriggerInput,
  type PublishWorkflowInput,
} from "@/workspace-settings/workflows/workflows.schemas";
import { WorkflowsService } from "@/workspace-settings/workflows/workflows.service";
import { ExternalV1Service } from "./external-v1.service";
import { guardChainDepth, idemKeyRequired } from "./v1-request-guards";

/**
 * /v1 WORKFLOWS — peeled from the 197-route ExternalV1Controller
 * (2026-07-31 split, slice 1). Same base path, same guard stack, same
 * per-key ceiling; ScopeGuard + check:v1-docs keep every route gated and
 * documented regardless of which class it lives in.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1WorkflowsController {
  constructor(
    private readonly api: ExternalV1Service,
    private readonly workflows: WorkflowsService,
  ) {}

  // ===========================================================================
  // WORKFLOWS
  // ===========================================================================
  //
  // Parity build, phase 2. The whole automation domain was UI-only.
  //
  // Scope split, deliberately: READS are `read:catalog` (a workflow is
  // configuration); EDITS and publish are `admin:settings` (publishing changes
  // what happens to everyone's conversations); FIRING a manual workflow is its
  // own `write:workflows`, because a run executes real step actions including
  // billed Meta sends — that is not a catalog write.

  @Get("workflows")
  @RequireScope("read:catalog")
  async listWorkflowsV1(@CurrentApiKey() auth: ApiKeyContext) {
    return this.workflows.list(auth.workspaceId);
  }

  @Get("workflows/:id")
  @RequireScope("read:catalog")
  async getWorkflowV1(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    return this.workflows.get(auth.workspaceId, id);
  }

  /**
   * Fire a `manual_trigger` workflow for one contact.
   *
   * `Idempotency-Key` is REQUIRED and the chain-depth guard applies: a run can
   * send billed messages, and a partner firing this from their own webhook
   * receiver is exactly the loop the depth cap exists for. The workflow must
   * be published and its trigger must be `manual_trigger` — anything else is
   * rejected rather than silently doing nothing.
   */
  @Post("workflows/:id/trigger")
  @RequireScope("write:workflows")
  @RateLimit({ perMinute: 60 })
  async triggerWorkflowV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ManualTriggerSchema)) body: ManualTriggerInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.api.triggerWorkflow(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      body,
      idemKeyRequired(idempotencyKey),
    );
  }

  /** Run history for one workflow — what fired, when, and how it ended. */
  @Get("workflows/:id/runs")
  @RequireScope("read:catalog")
  async listWorkflowRunsV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Query(zQuery(ListWorkflowRunsQuerySchema)) query: ListWorkflowRunsQuery,
  ) {
    return this.workflows.listRuns(auth.workspaceId, id, query);
  }

  /** One run, with its per-step journal — the first place to look when an
   *  automation "did nothing". */
  @Get("workflows/:id/runs/:runId")
  @RequireScope("read:catalog")
  async getWorkflowRunV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Param("runId") runId: string,
  ) {
    return this.workflows.getRun(auth.workspaceId, id, runId);
  }

  /**
   * Publish / unpublish. `admin:settings`: an unpublished workflow is inert,
   * so this switch is what makes automation live for the whole workspace.
   */
  @Post("workflows/:id/publish")
  @RequireScope("admin:settings")
  async publishWorkflowV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(PublishWorkflowSchema)) body: PublishWorkflowInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const out = await this.workflows.publish(auth.workspaceId, id, body.publish);
    return { ok: true, ...out };
  }

}
