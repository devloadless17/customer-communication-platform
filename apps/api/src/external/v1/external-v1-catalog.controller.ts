import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody } from "../../common/zod-validation.pipe";
import { guardChainDepth } from "./v1-request-guards";
import { AudienceGroupsService } from "@/workspace-settings/audience-groups/audience-groups.service";
import {
  CreateAudienceGroupSchema,
  UpdateAudienceGroupSchema,
  type CreateAudienceGroupInput,
  type UpdateAudienceGroupInput,
} from "@/workspace-settings/audience-groups/audience-groups.schemas";
import {
  CreateSnippetSchema,
  UpdateSnippetSchema,
  type CreateSnippetInput,
  type UpdateSnippetInput,
} from "@/workspace-settings/snippets/snippets.schemas";
import { SnippetsService } from "@/workspace-settings/snippets/snippets.service";

/**
 * /v1 AUDIENCE GROUPS + SNIPPETS — peeled from the 197-route ExternalV1Controller
 * (2026-07-31 split). Same base path + guard stack; check:v1-docs discovers
 * every *.controller.ts here, so the peel cannot drop a route from coverage.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1CatalogController {
  constructor(
    private readonly audienceGroups: AudienceGroupsService,
    private readonly snippets: SnippetsService,
  ) {}

  // AUDIENCE GROUPS
  // ===========================================================================
  //
  // Parity build, phase 1. A saved audience is what a broadcast targets, so
  // without these a partner could read campaigns but never build the list one
  // sends to. `write:catalog` matches the internal capability
  // (`audienceGroups:manage`, an admin/manager-grade catalog write).

  @Get("audience-groups")
  @RequireScope("read:catalog")
  async listAudienceGroupsV1(@CurrentApiKey() auth: ApiKeyContext) {
    const groups = await this.audienceGroups.list(auth.workspaceId);
    return { groups };
  }

  @Get("audience-groups/:id")
  @RequireScope("read:catalog")
  async getAudienceGroupV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    const group = await this.audienceGroups.get(auth.workspaceId, id);
    return { group };
  }

  @Post("audience-groups")
  @RequireScope("write:catalog")
  async createAudienceGroupV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateAudienceGroupSchema)) body: CreateAudienceGroupInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const group = await this.audienceGroups.create(auth.workspaceId, null, body);
    return { group };
  }

  @Patch("audience-groups/:id")
  @RequireScope("write:catalog")
  async updateAudienceGroupV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateAudienceGroupSchema)) body: UpdateAudienceGroupInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const group = await this.audienceGroups.update(auth.workspaceId, id, body);
    return { group };
  }

  @Delete("audience-groups/:id")
  @RequireScope("write:catalog")
  async deleteAudienceGroupV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.audienceGroups.remove(auth.workspaceId, id);
    return { ok: true };
  }

  // ===========================================================================
  // SNIPPETS
  // ===========================================================================
  //
  // Parity build, phase 1. `read/write:catalog` already ADVERTISED snippets
  // (see the scope descriptions) while no route existed.

  @Get("snippets")
  @RequireScope("read:catalog")
  async listSnippetsV1(@CurrentApiKey() auth: ApiKeyContext) {
    const snippets = await this.snippets.list(auth.workspaceId);
    return { snippets };
  }

  @Post("snippets")
  @RequireScope("write:catalog")
  async createSnippetV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateSnippetSchema)) body: CreateSnippetInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const created = await this.snippets.create(auth.workspaceId, null, body);
    return { ok: true, id: created.id };
  }

  @Patch("snippets/:id")
  @RequireScope("write:catalog")
  async updateSnippetV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateSnippetSchema)) body: UpdateSnippetInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.snippets.update(auth.workspaceId, id, body);
    return { ok: true };
  }

  @Delete("snippets/:id")
  @RequireScope("write:catalog")
  async deleteSnippetV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.snippets.remove(auth.workspaceId, id);
    return { ok: true };
  }
}

