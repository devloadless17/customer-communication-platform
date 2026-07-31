import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody } from "../../common/zod-validation.pipe";
import { ExternalSetLinkTrackingSchema, ExternalUpdateTemplateLabelsSchema, type ExternalSetLinkTrackingInput, type ExternalUpdateTemplateLabelsInput } from "./external-v1.schemas";
import { CreateQrCodeSchema, RegisterWhatsappNumberSchema, SetWhatsappUsernameSchema, UpdateBusinessProfileSchema, UpdateQrCodeSchema, type CreateQrCodeInput, type RegisterWhatsappNumberInput, type SetWhatsappUsernameInput, type UpdateBusinessProfileInput, type UpdateQrCodeInput } from "@/workspace-settings/whatsapp/whatsapp.schemas";
import { WhatsappService } from "@/workspace-settings/whatsapp/whatsapp.service";

/**
 * /v1 WHATSAPP SETTINGS + TEMPLATES — peeled from the ExternalV1Controller (2026-07-31 split).
 * Same base path + guard stack; check:v1-docs discovers every
 * *.controller.ts here, so a peel cannot drop a route from coverage.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1WhatsappController {
  constructor(
    private readonly whatsapp: WhatsappService,
  ) {}

  /**
   * Re-poll Meta for a number's tier / quality / throughput now, rather than
   * waiting for the periodic sweep. Parity with the settings Refresh button.
   * `admin:settings` — it spends Graph reads on the workspace's behalf.
   */
  @Post("whatsapp/health/refresh")
  @HttpCode(200)
  @RequireScope("admin:settings")
  async whatsappHealthRefresh(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.refreshHealth(auth.workspaceId, accountId || null);
  }

  /**
   * Register a number for Cloud API use (two-step PIN, passed straight
   * through to Meta and never stored). Parity with the UI's guided register.
   */
  @Post("whatsapp/register")
  @HttpCode(200)
  @RequireScope("admin:settings")
  async whatsappRegister(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(RegisterWhatsappNumberSchema)) body: RegisterWhatsappNumberInput,
  ) {
    return this.whatsapp.registerNumber(auth.workspaceId, body);
  }

  // ---- Template analytics ----------------------------------------------
  //
  // Meta's own aggregate performance per template per day — the only source of
  // real currency COST and of unique URL-button clicks. Read from the stored
  // rollup; `POST /broadcasts/:id/analytics/refresh` is what pulls fresh data
  // from Meta (deliberately manual — see the note on that route).
  //
  // These sit BESIDE the per-recipient funnel in `/broadcasts/:id/report`,
  // never merged into it: the two measure different things and will not agree.

  /**
   * Replace a template's organizational LABELS — the one part of a template
   * this API may write. Labels are OURS ("promo", "ramadan-2026"): Meta has no
   * such concept, nothing goes over the Graph wire, and a catalog re-sync
   * leaves them untouched. Parity with the internal templates PATCH;
   * `write:catalog` because labels are catalog taxonomy, like tags.
   */
  @Patch("templates/:id")
  @RequireScope("write:catalog")
  async updateTemplateLabels(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalUpdateTemplateLabelsSchema))
    body: ExternalUpdateTemplateLabelsInput,
  ) {
    await this.whatsapp.updateTemplateBindings(auth.workspaceId, id, {
      labels: body.labels,
    });
    return { ok: true };
  }

  /**
   * Lift a quality pause. Meta lifts a quality pause itself (3h, then 6h, then
   * it DISABLES the template), so this is for one paused by Template Pacing,
   * which never unpauses on its own. Campaigns parked for the template resume.
   */
  /**
   * Lift a Template-Pacing pause. `admin:settings`, not `write:catalog`:
   * unpausing RESUMES every broadcast campaign parked on this template — i.e.
   * it restarts irreversible billed sends. `write:catalog` is advertised as
   * "create/edit tags + custom fields"; a key minted for that must not be able
   * to restart a 50k-recipient campaign. Matches the internal twin's
   * `templates:manage` capability gate.
   */
  @Post("templates/:id/unpause")
  @RequireScope("admin:settings")
  async unpauseTemplate(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
  ) {
    await this.whatsapp.unpauseTemplate(auth.workspaceId, id);
    return { ok: true };
  }

  /**
   * Toggle button-click tracking on one template (Meta's
   * `cta_url_link_tracking_opted_out`). `admin:settings` like the internal
   * twin's `templates:manage` gate — it changes what analytics Meta records
   * for every future send of the template, workspace-wide.
   */
  @Post("templates/:id/link-tracking")
  @RequireScope("admin:settings")
  async setTemplateLinkTracking(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("id") id: string,
    @Body(zBody(ExternalSetLinkTrackingSchema)) body: ExternalSetLinkTrackingInput,
  ) {
    return this.whatsapp.setTemplateLinkTracking(auth.workspaceId, id, body.enabled);
  }

  /**
   * The business phone number's public profile — what a customer sees when they
   * tap the business name. `?accountId=` picks one of the workspace's numbers;
   * each has its own profile.
   */
  @Get("whatsapp/profile")
  @RequireScope("read:catalog")
  async businessProfile(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.getBusinessProfile(auth.workspaceId, accountId);
  }

  /** OBA standing + the owning WABA's record. Read-only. */
  @Get("whatsapp/account-status")
  @RequireScope("read:catalog")
  async accountStatus(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.getAccountStatus(auth.workspaceId, accountId);
  }

  @Post("whatsapp/profile")
  @RequireScope("admin:settings")
  async updateBusinessProfile(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpdateBusinessProfileSchema)) body: UpdateBusinessProfileInput,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.updateBusinessProfile(auth.workspaceId, body, accountId);
  }

  /**
   * QR codes & short links. Meta caps a number at 2,000 and publishes no scan
   * analytics, so this is pure CRUD — there is nothing to report on.
   */
  @Get("whatsapp/qr-codes")
  @RequireScope("read:catalog")
  async listQrCodes(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.listQrCodes(auth.workspaceId, accountId);
  }

  @Post("whatsapp/qr-codes")
  @RequireScope("admin:settings")
  async createQrCode(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(CreateQrCodeSchema)) body: CreateQrCodeInput,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.createQrCode(auth.workspaceId, body, accountId);
  }

  @Post("whatsapp/qr-codes/:code")
  @RequireScope("admin:settings")
  async updateQrCode(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("code") code: string,
    @Body(zBody(UpdateQrCodeSchema)) body: UpdateQrCodeInput,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.updateQrCode(auth.workspaceId, code, body, accountId);
  }

  /** Deleting a code breaks any signage printed with it — Meta shows the
   *  customer "this QR code has expired". */
  @Delete("whatsapp/qr-codes/:code")
  @RequireScope("admin:settings")
  async deleteQrCode(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("code") code: string,
    @Query("accountId") accountId?: string,
  ) {
    await this.whatsapp.deleteQrCode(auth.workspaceId, code, accountId);
    return { ok: true };
  }

  /**
   * The number's @username (a chat-native handle, 1:1 with the phone number,
   * globally unique across WhatsApp) plus Meta's reserved suggestions.
   * `?accountId=` picks one of the workspace's numbers.
   */
  @Get("whatsapp/username")
  @RequireScope("read:catalog")
  async whatsappUsername(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.getUsernameState(auth.workspaceId, accountId);
  }

  /**
   * Adopt or change it. A 409 `username_transfer_required` means the name is
   * on another of the portfolio's numbers — re-send with
   * `transferAction: "force_transfer"` to move it here deliberately.
   */
  @Post("whatsapp/username")
  @RequireScope("admin:settings")
  async setWhatsappUsername(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(SetWhatsappUsernameSchema)) body: SetWhatsappUsernameInput,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.setUsername(auth.workspaceId, body, accountId);
  }

  /** Remove it. Customers who saved the @handle lose that route to the chat. */
  @Delete("whatsapp/username")
  @RequireScope("admin:settings")
  async deleteWhatsappUsername(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("accountId") accountId?: string,
  ) {
    await this.whatsapp.deleteUsername(auth.workspaceId, accountId);
    return { ok: true };
  }

}
