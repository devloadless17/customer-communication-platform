import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";

import { CurrentSession } from "../auth/current-session.decorator";
import { RequireRole } from "../auth/role.guard";
import { SessionGuard } from "../auth/session.guard";
import type { ApiSession } from "../auth/session.guard";
import { zBody } from "../common/zod-validation.pipe";
import { AssignmentService } from "./assignment.service";
import {
  CreatePolicySchema,
  CreateRuleSchema,
  PreviewAssignmentSchema,
  ReorderRulesSchema,
  UpdateAssignmentSettingsSchema,
  UpdatePolicySchema,
  UpdateRuleSchema,
  type CreatePolicyInput,
  type CreateRuleInput,
  type PreviewAssignmentInput,
  type ReorderRulesInput,
  type UpdateAssignmentSettingsInput,
  type UpdatePolicyInput,
  type UpdateRuleInput,
} from "./assignment.schemas";

/**
 * Assignment routing configuration.
 *
 *   GET    /api/team/assignment                    — everything the page needs
 *   POST   /api/team/assignment/policies           — create a policy
 *   PUT    /api/team/assignment/policies/:id       — update (CAS on version)
 *   POST   /api/team/assignment/policies/:id/default — make it the fallback
 *   DELETE /api/team/assignment/policies/:id       — archive
 *   POST   /api/team/assignment/rules              — create a routing rule
 *   PATCH  /api/team/assignment/rules/:id          — update
 *   DELETE /api/team/assignment/rules/:id          — delete
 *   PUT    /api/team/assignment/rules/order        — reorder (first match wins)
 *   PATCH  /api/team/assignment/settings           — auto-assign switchboard
 *   POST   /api/team/assignment/preview            — dry run "who gets this?"
 *
 * Admin-only across the board. Routing decides who gets paid work; unlike the
 * per-capability settings this one stays on the role gate deliberately — it's
 * the same posture as role permissions themselves.
 *
 * GET is admin-only too, because it exposes every member's live open-conversation
 * load. The inbox never needs this endpoint; it learns about assignments from
 * `conversation:assigned` socket frames like it always has.
 */
@Controller("api/team/assignment")
@UseGuards(SessionGuard)
@RequireRole("admin")
export class AssignmentController {
  constructor(private readonly assignment: AssignmentService) {}

  @Get()
  async overview(@CurrentSession() session: ApiSession) {
    return this.assignment.getOverview(session.teamId);
  }

  @Post("policies")
  async createPolicy(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreatePolicySchema)) body: CreatePolicyInput,
  ) {
    return this.assignment.createPolicy(session.teamId, body);
  }

  @Put("policies/:id")
  async updatePolicy(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdatePolicySchema)) body: UpdatePolicyInput,
  ) {
    return this.assignment.updatePolicy(session.teamId, id, body);
  }

  @Post("policies/:id/default")
  async setDefault(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.assignment.setDefaultPolicy(session.teamId, id);
  }

  @Delete("policies/:id")
  async archivePolicy(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.assignment.archivePolicy(session.teamId, id);
  }

  @Post("rules")
  async createRule(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateRuleSchema)) body: CreateRuleInput,
  ) {
    return this.assignment.createRule(session.teamId, body);
  }

  // Declared BEFORE `rules/:id` so "order" isn't swallowed as an id — Nest
  // matches routes in declaration order.
  @Put("rules/order")
  async reorderRules(
    @CurrentSession() session: ApiSession,
    @Body(zBody(ReorderRulesSchema)) body: ReorderRulesInput,
  ) {
    return this.assignment.reorderRules(session.teamId, body.ruleIds);
  }

  @Patch("rules/:id")
  async updateRule(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
    @Body(zBody(UpdateRuleSchema)) body: UpdateRuleInput,
  ) {
    return this.assignment.updateRule(session.teamId, id, body);
  }

  @Delete("rules/:id")
  async deleteRule(@CurrentSession() session: ApiSession, @Param("id") id: string) {
    return this.assignment.deleteRule(session.teamId, id);
  }

  @Patch("settings")
  async updateSettings(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateAssignmentSettingsSchema)) body: UpdateAssignmentSettingsInput,
  ) {
    return this.assignment.updateSettings(session.teamId, body);
  }

  @Post("preview")
  async preview(
    @CurrentSession() session: ApiSession,
    @Body(zBody(PreviewAssignmentSchema)) body: PreviewAssignmentInput,
  ) {
    return this.assignment.preview(session.teamId, body);
  }
}
