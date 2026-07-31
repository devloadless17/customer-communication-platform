import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Put, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody } from "../../common/zod-validation.pipe";
import { CreatePolicySchema, CreateRuleSchema, PreviewAssignmentSchema, ReorderRulesSchema, UpdateAssignmentSettingsSchema, UpdatePolicySchema, UpdateRuleSchema, type CreatePolicyInput, type CreateRuleInput, type PreviewAssignmentInput, type ReorderRulesInput, type UpdateAssignmentSettingsInput, type UpdatePolicyInput, type UpdateRuleInput } from "@/assignment/assignment.schemas";
import { guardChainDepth } from "./v1-request-guards";
import { AssignmentService } from "@/assignment/assignment.service";

/**
 * /v1 ASSIGNMENT (policies / rules / settings) — peeled from the ExternalV1Controller (2026-07-31 split).
 * Same base path + guard stack; check:v1-docs discovers every
 * *.controller.ts here, so a peel cannot drop a route from coverage.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1AssignmentController {
  constructor(
    private readonly assignment: AssignmentService,
  ) {}

  @Get("assignment")
  @RequireScope("read:catalog")
  async getAssignment(@CurrentApiKey() auth: ApiKeyContext) {
    return this.assignment.getOverview(auth.workspaceId);
  }

  @Post("assignment/policies")
  @RequireScope("admin:settings")
  async createAssignmentPolicy(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreatePolicySchema)) body: CreatePolicyInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.assignment.createPolicy(auth.workspaceId, body);
  }

  @Put("assignment/policies/:id")
  @RequireScope("admin:settings")
  async updateAssignmentPolicy(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdatePolicySchema)) body: UpdatePolicyInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.assignment.updatePolicy(auth.workspaceId, id, body);
  }

  @Post("assignment/policies/:id/default")
  @RequireScope("admin:settings")
  async setDefaultAssignmentPolicy(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.assignment.setDefaultPolicy(auth.workspaceId, id);
  }

  @Delete("assignment/policies/:id")
  @RequireScope("admin:settings")
  async archiveAssignmentPolicy(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.assignment.archivePolicy(auth.workspaceId, id);
  }

  @Post("assignment/rules")
  @RequireScope("admin:settings")
  async createAssignmentRule(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateRuleSchema)) body: CreateRuleInput,
  ) {
    return this.assignment.createRule(auth.workspaceId, body);
  }

  // Before `rules/:id` — Nest matches in declaration order.
  @Put("assignment/rules/order")
  @RequireScope("admin:settings")
  async reorderAssignmentRules(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ReorderRulesSchema)) body: ReorderRulesInput,
  ) {
    return this.assignment.reorderRules(auth.workspaceId, body.ruleIds);
  }

  @Patch("assignment/rules/:id")
  @RequireScope("admin:settings")
  async updateAssignmentRule(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateRuleSchema)) body: UpdateRuleInput,
  ) {
    return this.assignment.updateRule(auth.workspaceId, id, body);
  }

  @Delete("assignment/rules/:id")
  @RequireScope("admin:settings")
  async deleteAssignmentRule(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.assignment.deleteRule(auth.workspaceId, id);
  }

  @Patch("assignment/settings")
  @RequireScope("admin:settings")
  async updateAssignmentSettings(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpdateAssignmentSettingsSchema)) body: UpdateAssignmentSettingsInput,
  ) {
    return this.assignment.updateSettings(auth.workspaceId, body);
  }

  /** Dry run: "who would take a conversation like this?" Read-only — never
   *  advances rotation or weighted counters, so it's safe to poll. */
  @Post("assignment/preview")
  @RequireScope("read:catalog")
  async previewAssignment(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(PreviewAssignmentSchema)) body: PreviewAssignmentInput,
  ) {
    return this.assignment.preview(auth.workspaceId, body);
  }

  // ---- Conversations ------------------------------------------------

  // ── Broadcasts (read-only) ────────────────────────────────────────────────
  // Clients pull campaign results into their own BI. Same DTO the in-app report
  // renders, so the API and the UI can never disagree about a number.

  // ── Channel accounts ────────────────────────────────────────────────────
  // Which accounts a workspace has connected per channel, and which one is the
  // send default. Read-only: connecting/disconnecting moves real credentials
  // and changes which number a customer hears from (see the scope comment).

}
