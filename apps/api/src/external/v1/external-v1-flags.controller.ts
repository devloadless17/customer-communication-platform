import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import { ExternalCreateFlagDefinitionSchema, ExternalListFlagsQuerySchema, ExternalRaiseFlagSchema, ExternalUpdateFlagDefinitionSchema, ExternalUpdateFlagSchema, type ExternalCreateFlagDefinitionInput, type ExternalListFlagsQueryInput, type ExternalRaiseFlagInput, type ExternalUpdateFlagDefinitionInput, type ExternalUpdateFlagInput } from "./external-v1.schemas";
import { guardChainDepth } from "./v1-request-guards";
import { ExternalV1FlagsService } from "./external-v1-flags.service";

/**
 * /v1 MESSAGE FLAGS — peeled from the ExternalV1Controller (2026-07-31 split).
 * Same base path + guard stack; check:v1-docs discovers every
 * *.controller.ts here, so a peel cannot drop a route from coverage.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1FlagsController {
  constructor(
    private readonly flags: ExternalV1FlagsService,
  ) {}

  @Get("message-flags")
  @RequireScope("read:flags")
  async listMessageFlags(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ExternalListFlagsQuerySchema)) query: ExternalListFlagsQueryInput,
  ) {
    return this.flags.list(auth.workspaceId, query);
  }

  /** Static segments before the `:flagId` routes below. */
  @Get("message-flags/counts")
  @RequireScope("read:flags")
  async messageFlagCounts(@CurrentApiKey() auth: ApiKeyContext) {
    return this.flags.counts(auth.workspaceId);
  }

  /** The flag CATALOG (which flags exist), archived included. Lives under
   *  `read:catalog` with every other catalog read. */
  @Get("message-flag-definitions")
  @RequireScope("read:catalog")
  async listMessageFlagDefinitions(@CurrentApiKey() auth: ApiKeyContext) {
    return this.flags.listDefinitions(auth.workspaceId);
  }

  @Post("message-flag-definitions")
  @RequireScope("write:catalog")
  async createMessageFlagDefinition(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ExternalCreateFlagDefinitionSchema)) body: ExternalCreateFlagDefinitionInput,
  ) {
    return this.flags.createDefinition(auth.workspaceId, body);
  }

  @Patch("message-flag-definitions/:id")
  @RequireScope("write:catalog")
  async updateMessageFlagDefinition(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalUpdateFlagDefinitionSchema)) body: ExternalUpdateFlagDefinitionInput,
  ) {
    return this.flags.updateDefinition(auth.workspaceId, id, body);
  }

  /** Only permitted while the definition has never been raised — otherwise 409
   *  with `message_flag_definition_in_use`; archive it instead
   *  (`PATCH … { "archived": true }`) so the triage history stays readable. */
  @Delete("message-flag-definitions/:id")
  @RequireScope("write:catalog")
  async deleteMessageFlagDefinition(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.flags.deleteDefinition(auth.workspaceId, id);
  }

  // ---- Saved inbox views ---------------------------------------------
  //
  // A named, reusable filter over the conversation list ("Support ·
  // unassigned · WhatsApp"). Full parity with the inbox rail — the SAME
  // service backs both, so a view can never select different conversations
  // through the API than it shows in the product.
  //
  // API-KEY SPECIFICS, both consequences of a key not being a person:
  //   - only SHARED views are visible or creatable (a personal view needs an
  //     owner; creating one returns `inbox_view_requires_user`);
  //   - a view whose assignee is "me" matches NOTHING here, deliberately —
  //     silently widening it to everyone would be the dangerous direction.
  //
  // To LIST the conversations a view selects, pass its id to
  // `GET /v1/conversations?viewId=…`.

  @Post("messages/:messageId/flags")
  @RequireScope("write:flags")
  async raiseMessageFlag(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("messageId") messageId: string,
    @Body(zBody(ExternalRaiseFlagSchema)) body: ExternalRaiseFlagInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    // No Idempotency-Key requirement here, unlike sends: raising a flag is
    // idempotent by construction (@@unique([messageId, definitionId]) + upsert)
    // and costs nothing, so demanding a key would be friction with no payoff.
    return this.flags.raise(auth.workspaceId, auth.apiKeyId, messageId, body);
  }

  @Patch("message-flags/:flagId")
  @RequireScope("write:flags")
  async updateMessageFlag(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("flagId") flagId: string,
    @Body(zBody(ExternalUpdateFlagSchema)) body: ExternalUpdateFlagInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.flags.update(auth.workspaceId, auth.apiKeyId, flagId, body);
  }

  @Delete("message-flags/:flagId")
  @RequireScope("write:flags")
  async deleteMessageFlag(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("flagId") flagId: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.flags.remove(auth.workspaceId, auth.apiKeyId, flagId);
  }

  // ---- Calls --------------------------------------------------------
  //
  // Read history and permission state, ask a customer for calling permission,
  // and send them a call button. There is deliberately no "place a call": a
  // call needs an SDP offer from a live WebRTC peer and a browser to carry the
  // audio, so an API client has nothing to place one with. What's here is the
  // part an integration can genuinely drive.

}
