import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import { CreatePersonaSchema, StickerCatalogQuerySchema, ThreadControlSchema, UpdateMessengerEntryPointsSchema, UpdateMessengerWelcomeSchema, type CreatePersonaInput, type StickerCatalogQuery, type ThreadControlInput, type UpdateMessengerEntryPointsInput, type UpdateMessengerWelcomeInput } from "@/workspace-settings/messenger/messenger.schemas";
import { MessengerService } from "@/workspace-settings/messenger/messenger.service";

/**
 * /v1 MESSENGER SURFACE — peeled from the ExternalV1Controller (2026-07-31 split).
 * Same base path + guard stack; check:v1-docs discovers every
 * *.controller.ts here, so a peel cannot drop a route from coverage.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1MessengerController {
  constructor(
    private readonly messenger: MessengerService,
  ) {}

  @Get("channels/messenger/entry-points")
  @RequireScope("admin:settings")
  async getMessengerEntryPoints(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("account_id") accountId?: string,
  ) {
    // `null` = could not read. Treat as unknown, NOT empty — see the Instagram twin.
    return {
      entry_points: await this.messenger.getEntryPoints(
        auth.workspaceId,
        accountId?.trim() || undefined,
      ),
    };
  }

  @Post("channels/messenger/entry-points")
  @RequireScope("admin:settings")
  async setMessengerEntryPoints(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpdateMessengerEntryPointsSchema)) body: UpdateMessengerEntryPointsInput,
  ) {
    return {
      ok: true,
      entry_points: await this.messenger.setEntryPoints(auth.workspaceId, body),
    };
  }

  @Get("channels/messenger/welcome")
  @RequireScope("admin:settings")
  async getMessengerWelcome(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("account_id") accountId?: string,
  ) {
    return {
      welcome: await this.messenger.getWelcome(
        auth.workspaceId,
        accountId?.trim() || undefined,
      ),
    };
  }

  @Post("channels/messenger/welcome")
  @RequireScope("admin:settings")
  async setMessengerWelcome(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpdateMessengerWelcomeSchema)) body: UpdateMessengerWelcomeInput,
  ) {
    return { ok: true, welcome: await this.messenger.setWelcome(auth.workspaceId, body) };
  }

  @Get("channels/messenger/stickers")
  @RequireScope("read:catalog")
  async messengerStickers(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(StickerCatalogQuerySchema)) query: StickerCatalogQuery,
  ) {
    return { catalog: await this.messenger.stickers(auth.workspaceId, query) };
  }

  @Post("channels/messenger/thread-control")
  @RequireScope("write:conversations")
  async messengerThreadControl(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(ThreadControlSchema)) body: ThreadControlInput,
  ) {
    return { ok: true, ...(await this.messenger.threadControl(auth.workspaceId, body)) };
  }

  @Get("channels/messenger/thread-owner")
  @RequireScope("read:channels")
  async messengerThreadOwner(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("psid") psid: string,
    @Query("account_id") accountId?: string,
  ) {
    return {
      owner_app_id: await this.messenger.threadOwner(
        auth.workspaceId,
        psid,
        accountId?.trim() || undefined,
      ),
    };
  }

  // Personas + utility templates. Both read Meta live with no local mirror.
  //
  // `read:catalog` for the two READS: neither returns workspace data — a persona
  // is a display name and an avatar, a utility template is Meta-approved copy —
  // and the composer needs both without an admin-grade key. Creating or deleting
  // a persona changes what every future customer SEES, so those stay
  // `admin:settings`.
  @Get("channels/messenger/personas")
  @RequireScope("read:catalog")
  async messengerPersonas(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("account_id") accountId?: string,
  ) {
    return {
      personas: await this.messenger.personas(auth.workspaceId, accountId?.trim() || undefined),
    };
  }

  @Post("channels/messenger/personas")
  @RequireScope("admin:settings")
  async createMessengerPersona(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreatePersonaSchema)) body: CreatePersonaInput,
  ) {
    return { ok: true, persona: await this.messenger.createPersona(auth.workspaceId, body) };
  }

  @Delete("channels/messenger/personas/:personaId")
  @RequireScope("admin:settings")
  async deleteMessengerPersona(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("personaId") personaId: string,
    @Query("account_id") accountId?: string,
  ) {
    await this.messenger.deletePersona(
      auth.workspaceId,
      personaId,
      accountId?.trim() || undefined,
    );
    return { ok: true };
  }

  // Sending a Messenger template. `write:messages` — it IS a message send, not a
  // settings change, and an integration that posts order updates should not need
  // an admin-grade key. Rate-limited like the other sends.
  @Get("channels/messenger/broadcast-reach")
  @RequireScope("read:catalog")
  async messengerBroadcastReach(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("template_name") templateName?: string,
  ) {
    return this.messenger.broadcastReach(auth.workspaceId, templateName?.trim() || undefined);
  }

  @Get("channels/messenger/utility-templates")
  @RequireScope("read:catalog")
  async messengerUtilityTemplates(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("account_id") accountId?: string,
  ) {
    return {
      templates: await this.messenger.utilityTemplates(
        auth.workspaceId,
        accountId?.trim() || undefined,
      ),
    };
  }

}
