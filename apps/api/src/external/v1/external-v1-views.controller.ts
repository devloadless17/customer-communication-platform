import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import { ListConversationsQuerySchema, type ListConversationsQueryInput } from "./external-v1.schemas";
import { CreateInboxViewSchema, UpdateInboxViewSchema, type CreateInboxViewInput, type UpdateInboxViewInput } from "@/inbox-views/inbox-views.schemas";
import { inboxViewWhereClauses } from "@/lib/inbox-views/where";
import { hasScope } from "@ccp/shared/api-keys/scopes";
import { InboxViewsService, type InboxViewActor } from "@/inbox-views/inbox-views.service";
import { ExternalV1Service } from "./external-v1.service";

/**
 * /v1 INBOX VIEWS — peeled from the ExternalV1Controller (2026-07-31 split).
 * Same base path + guard stack; check:v1-docs discovers every
 * *.controller.ts here, so a peel cannot drop a route from coverage.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1ViewsController {
  constructor(
    private readonly api: ExternalV1Service,
    private readonly inboxViews: InboxViewsService,
  ) {}

  @Get("conversations")
  @RequireScope("read:conversations")
  async listConversations(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query(zQuery(ListConversationsQuerySchema)) query: ListConversationsQueryInput,
  ) {
    // Resolve the saved view HERE, where the membership check lives — a key
    // only sees shared views, and an id from another workspace 404s before it
    // can become a WHERE clause. `resolveFilters` then drops references to
    // tags / stages / teammates that have since been deleted.
    const viewClauses = query.viewId
      ? inboxViewWhereClauses(
          await this.inboxViews.resolveFilters(
            auth.workspaceId,
            (await this.inboxViews.get(apiKeyViewActor(auth), query.viewId)).filters,
          ),
          // No viewer: an API key is not a person, so a view whose assignee is
          // "me" matches nothing rather than everything.
          undefined,
        )
      : [];

    return this.api.listConversations(
      auth.workspaceId,
      query,
      hasScope(auth.scopes, "read:contacts"),
      viewClauses,
    );
  }

  @Get("inbox-views")
  @RequireScope("read:catalog")
  async listInboxViews(@CurrentApiKey() auth: ApiKeyContext) {
    const views = await this.inboxViews.list(apiKeyViewActor(auth));
    return { views };
  }

  @Get("inbox-views/:id")
  @RequireScope("read:catalog")
  async getInboxView(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    const view = await this.inboxViews.get(apiKeyViewActor(auth), id);
    return { view };
  }

  @Post("inbox-views")
  @RequireScope("write:catalog")
  async createInboxView(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateInboxViewSchema)) body: CreateInboxViewInput,
  ) {
    const view = await this.inboxViews.create(apiKeyViewActor(auth), {
      ...body,
      // A key has no personal scope, so default to shared rather than letting
      // the service's personal default throw on every unqualified create.
      visibility: body.visibility ?? "shared",
    });
    return { view };
  }

  @Patch("inbox-views/:id")
  @RequireScope("write:catalog")
  async updateInboxView(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateInboxViewSchema)) body: UpdateInboxViewInput,
  ) {
    const view = await this.inboxViews.update(apiKeyViewActor(auth), id, body);
    return { view };
  }

  @Delete("inbox-views/:id")
  @RequireScope("write:catalog")
  async deleteInboxView(@CurrentApiKey() auth: ApiKeyContext, @Param("id") id: string) {
    await this.inboxViews.remove(apiKeyViewActor(auth), id);
    return { ok: true };
  }

  // ---- WhatsApp messaging health --------------------------------------
  //
  // What Meta currently allows the workspace's WhatsApp number to send: the
  // messaging tier and its 24h unique-recipient cap, how much of that budget is
  // already spent, the quality rating, and the throughput ceiling.
  //
  // Worth exposing because it is the ONLY way an integration can size a
  // campaign before submitting it. Without it a partner discovers the cap by
  // having a 10k send refused — and the refusal is correct, so there is nothing
  // to retry. `remainingDailyBudget` is the number to plan against.
  //
  // Read-only, and secret-free (no tokens, no App secret), so it sits under
  // `read:catalog` rather than requiring a credential-bearing scope.

}

/**
 * An API key as a saved-view actor.
 *
 * `userId: null` is the whole point — it makes the service treat this caller
 * as "not a person": shared views only, no personal ownership, and `me`
 * assignee filters resolve to nothing. `canManageShared: true` because a key
 * holding `write:catalog` is already trusted with workspace-wide
 * configuration; gating it further would only mean a partner can create tags
 * and stages but not the view that uses them.
 */
function apiKeyViewActor(auth: ApiKeyContext): InboxViewActor {
  return { workspaceId: auth.workspaceId, userId: null, canManageShared: true };
}
