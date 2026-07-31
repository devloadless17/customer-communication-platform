import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import { guardChainDepth } from "./v1-request-guards";
import { OutboundWebhooksService } from "@/workspace-settings/outbound-webhooks/outbound-webhooks.service";
import {
  CreateOutboundWebhookSchema,
  ListDeliveriesQuerySchema,
  UpdateOutboundWebhookSchema,
  type CreateOutboundWebhookInput,
  type ListDeliveriesQueryInput,
  type UpdateOutboundWebhookInput,
} from "@/workspace-settings/outbound-webhooks/outbound-webhooks.schemas";

/**
 * /v1 OUTBOUND WEBHOOKS (management) — peeled from the 197-route ExternalV1Controller
 * (2026-07-31 split). Same base path + guard stack; check:v1-docs discovers
 * every *.controller.ts here, so the peel cannot drop a route from coverage.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1OutboundWebhooksController {
  constructor(
    private readonly outboundWebhooks: OutboundWebhooksService,
  ) {}

  // OUTBOUND WEBHOOKS (management)
  // ===========================================================================
  //
  // Parity build, phase 1. Registering a webhook was UI-only, so a partner
  // could not receive a single event until a human clicked through Settings —
  // the biggest self-serve onboarding blocker in the API.
  //
  // `admin:settings` on every route, including the reads: a webhook endpoint is
  // a standing DATA-EGRESS grant (every subscribed event body leaves the
  // system), and the secret it returns signs that traffic. The internal twin is
  // admin-only for the same reason.

  @Get("outbound-webhooks")
  @RequireScope("admin:settings")
  async listOutboundWebhooksV1(@CurrentApiKey() auth: ApiKeyContext) {
    const webhooks = await this.outboundWebhooks.list(auth.workspaceId);
    return { webhooks };
  }

  /** The signing secret is returned ONCE here and never again — same contract
   *  as an API key. Store it before you acknowledge the response. */
  @Post("outbound-webhooks")
  @RequireScope("admin:settings")
  @RateLimit({ perMinute: 10 })
  async createOutboundWebhookV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateOutboundWebhookSchema)) body: CreateOutboundWebhookInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    // `createdById: null` — an API key is not a person. The service already
    // treats a null creator as "created by an integration".
    return this.outboundWebhooks.create(auth.workspaceId, null, body);
  }

  @Patch("outbound-webhooks/:id")
  @RequireScope("admin:settings")
  async updateOutboundWebhookV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(UpdateOutboundWebhookSchema)) body: UpdateOutboundWebhookInput,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const webhook = await this.outboundWebhooks.update(auth.workspaceId, id, body);
    return { webhook };
  }

  /** Rotate the signing secret. Returns the new one ONCE; the old one stops
   *  validating immediately, so swap it on your side in the same deploy. */
  @Post("outbound-webhooks/:id/rotate-secret")
  @RequireScope("admin:settings")
  @RateLimit({ perMinute: 10 })
  async rotateOutboundWebhookSecretV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.outboundWebhooks.rotateSecret(auth.workspaceId, id);
  }

  @Delete("outbound-webhooks/:id")
  @RequireScope("admin:settings")
  async deleteOutboundWebhookV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.outboundWebhooks.remove(auth.workspaceId, id);
    return { ok: true };
  }

  /**
   * Delivery log for one webhook — what we sent, the response code, and the
   * retry state. `OutboundWebhookDelivery` carries no `workspaceId` of its own
   * (documented parent-scoped tenancy exception), so the service proves
   * ownership of the PARENT webhook before reading any delivery row.
   */
  @Get("outbound-webhooks/:id/deliveries")
  @RequireScope("admin:settings")
  async listOutboundWebhookDeliveriesV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Query(zQuery(ListDeliveriesQuerySchema)) query: ListDeliveriesQueryInput,
  ) {
    return this.outboundWebhooks.listDeliveries(auth.workspaceId, id, query);
  }

  /** Fire a signed sample delivery so an integration can verify its endpoint +
   *  signature check before real traffic depends on it. */
  @Post("outbound-webhooks/:id/test")
  @RequireScope("admin:settings")
  @RateLimit({ perMinute: 10 })
  async testOutboundWebhookV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.outboundWebhooks.test(auth.workspaceId, id);
  }

  // ===========================================================================
}
