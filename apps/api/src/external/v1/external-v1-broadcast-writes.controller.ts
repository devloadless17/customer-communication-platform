import { Body, ConflictException, Controller, Delete, Get, Headers, Param, Post, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody } from "../../common/zod-validation.pipe";
import { guardChainDepth, idemKeyRequired } from "./v1-request-guards";
import {
  CreateBroadcastSchema,
  PreviewMissingFieldsSchema,
  RetryBroadcastSchema,
  type CreateBroadcastInput,
  type PreviewMissingFieldsInput,
  type RetryBroadcastInput,
} from "@/broadcasts/broadcasts.schemas";
import { BroadcastsService } from "@/broadcasts/broadcasts.service";
import { ExternalV1Service } from "./external-v1.service";

/**
 * /v1 BROADCAST WRITES — peeled from the ExternalV1Controller (2026-07-31 split).
 * Same base path + guard stack; check:v1-docs discovers every
 * *.controller.ts here, so a peel cannot drop a route from coverage.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1BroadcastWritesController {
  constructor(
    private readonly api: ExternalV1Service,
    private readonly broadcasts: BroadcastsService,
  ) {}

  // BROADCAST WRITES
  // ===========================================================================
  //
  // Parity build, phase 3. The read surface has existed for a while; the write
  // surface was UI-only.
  //
  // `write:broadcasts` is a NEW scope and the most dangerous one in the API: a
  // create sends billed template messages to an entire audience and there is
  // no unsend. `read:broadcasts` deliberately does not imply it, so a
  // reporting integration can never be one typo away from launching a
  // campaign. Create and retry both REQUIRE an `Idempotency-Key`.

  /**
   * Launch a campaign (or schedule one — pass `scheduledAt`).
   *
   * `Idempotency-Key` REQUIRED and claimed irreversibly: a retry after a
   * gateway timeout must never produce a second campaign to the same audience,
   * and an ambiguous crash must not auto-clear into a re-send.
   */
  @Post("broadcasts")
  @RequireScope("write:broadcasts")
  @RateLimit({ perMinute: 10 })
  async createBroadcastV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateBroadcastSchema)) body: CreateBroadcastInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.api.createBroadcast(
      auth.workspaceId,
      auth.apiKeyId,
      body,
      idemKeyRequired(idempotencyKey),
    );
  }

  /**
   * Pre-send preflight: how many recipients would resolve a template variable
   * to empty and be rejected by WhatsApp. Read-only — call it before create so
   * you find out now rather than from the failure report.
   */
  @Post("broadcasts/preview-missing")
  @RequireScope("read:broadcasts")
  @RateLimit({ perMinute: 20 })
  async previewBroadcastMissingV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(PreviewMissingFieldsSchema)) body: PreviewMissingFieldsInput,
  ) {
    return this.broadcasts.previewMissingFields(auth.workspaceId, body);
  }

  /** Stop a running or scheduled campaign. Recipients already accepted by Meta
   *  stay sent — a message cannot be unsent. */
  @Post("broadcasts/:id/cancel")
  @RequireScope("write:broadcasts")
  async cancelBroadcastV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.broadcasts.cancel(auth.workspaceId, id);
    return { ok: true };
  }

  /**
   * Explicitly resume a PAUSED campaign. The only path that may lift an
   * `abuse_warning` pause — automatic recovery deliberately excludes it, so a
   * human choosing to continue after seeing the pause reason is the review
   * Meta's warning asks for. 409 `broadcast_not_paused` otherwise.
   */
  @Post("broadcasts/:id/resume")
  @RequireScope("write:broadcasts")
  async resumeBroadcastV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    const resumed = await this.broadcasts.resume(auth.workspaceId, id);
    if (!resumed) {
      throw new ConflictException({ error: "broadcast_not_paused" });
    }
    return { ok: true };
  }

  /**
   * Re-queue FAILED recipients. `errorCodes` narrows it to one failure bucket,
   * so you can retry the rate-limited without also re-sending to numbers that
   * are permanently invalid. `Idempotency-Key` REQUIRED — this bills again.
   */
  @Post("broadcasts/:id/retry")
  @RequireScope("write:broadcasts")
  @RateLimit({ perMinute: 10 })
  async retryBroadcastV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(RetryBroadcastSchema)) body: RetryBroadcastInput,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    return this.api.retryBroadcast(
      auth.workspaceId,
      auth.apiKeyId,
      id,
      body,
      idemKeyRequired(idempotencyKey),
    );
  }

  /** Delete a campaign and its recipient rows. Terminal campaigns only — the
   *  service refuses one that is still running. */
  @Delete("broadcasts/:id")
  @RequireScope("write:broadcasts")
  async deleteBroadcastV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Headers("x-ccp-depth") xCcpDepth?: string,
  ) {
    guardChainDepth(xCcpDepth);
    await this.broadcasts.remove(auth.workspaceId, id);
    return { ok: true };
  }

  /** Every recipient contact id for a campaign — for building a follow-up
   *  audience from who actually received it. */
  @Get("broadcasts/:id/recipient-ids")
  @RequireScope("read:broadcasts")
  async listBroadcastRecipientIdsV1(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.broadcasts.listRecipientContactIds(auth.workspaceId, id);
  }


  /**
   * Pull Meta's own template analytics for this campaign (currency cost +
   * unique link clicks — figures the per-recipient funnel cannot derive).
   *
   * Documented in both doc surfaces since the analytics work landed but never
   * implemented on /v1, so an API-only integration got a 404 and its
   * `report.metaAnalytics` block stayed permanently stale — the internal
   * dashboard was the only way to refresh it. `read:broadcasts` because it
   * fetches and caches a report figure; it changes no campaign state.
   */
  @Post("broadcasts/:id/analytics/refresh")
  @RequireScope("read:broadcasts")
  @RateLimit({ perMinute: 10 })
  async refreshBroadcastAnalytics(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    return this.broadcasts.refreshAnalytics(auth.workspaceId, id);
  }

}
