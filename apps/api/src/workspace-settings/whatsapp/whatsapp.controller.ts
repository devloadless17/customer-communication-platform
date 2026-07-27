import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RateLimit } from "../../common/rate-limit.interceptor";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  CreateQrCodeSchema,
  UpdateQrCodeSchema,
  UpdateBusinessProfileSchema,
  UpdateWhatsappConfigSchema,
  type CreateQrCodeInput,
  type UpdateQrCodeInput,
  type UpdateBusinessProfileInput,
  type UpdateWhatsappConfigInput,
} from "./whatsapp.schemas";
import { WhatsappService } from "./whatsapp.service";
import {
  enableTemplateInsights,
  getInsightsStatus,
} from "@/lib/analytics/template-analytics";

/**
 * WhatsApp Cloud API connection settings — admin-only.
 *
 *   GET    /api/workspace/whatsapp    — current config + decrypted display values
 *                                  (admin form pre-fill — see service for
 *                                  the security tradeoff around exposing
 *                                  plaintext secrets to the admin's browser)
 *   POST   /api/workspace/whatsapp    — set/update credentials (validates against Meta first)
 *   GET    /api/workspace/whatsapp/profile   — the number's public business profile
 *   POST   /api/workspace/whatsapp/profile   — update it (?accountId= picks the number)
 *   GET/POST/DELETE /api/workspace/whatsapp/qr-codes[/:code]
 *                                — QR codes + short links for the number
 *   DELETE /api/workspace/whatsapp    — disconnect (wipes secrets, keeps history)
 *   GET    /api/workspace/whatsapp/insights/status
 *                                — is template analytics on for this WABA?
 *   POST   /api/workspace/whatsapp/insights/enable
 *                                — turn it on (IRREVERSIBLE at Meta)
 *   POST   /api/workspace/whatsapp/health/refresh
 *                                — re-poll Meta for tier / quality / throughput
 *                                  and re-resolve the owning portfolio
 *
 * Template endpoints live in WhatsappTemplatesController (any agent on the
 * team can refresh/create/delete — templates are catalog data, not secret
 * state).
 */
@Controller("api/workspace/whatsapp")
@RequireRole("admin")
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Get()
  async get(@CurrentSession() session: ApiSession) {
    const config = await this.whatsapp.getConfig(session.workspaceId);
    return { config };
  }

  @Post()
  async update(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateWhatsappConfigSchema)) body: UpdateWhatsappConfigInput,
  ) {
    const out = await this.whatsapp.updateConfig(session.workspaceId, body);
    return { ok: true, ...out };
  }

  /**
   * Force a health re-poll.
   *
   * The snapshot is normally kept current by Meta's webhooks plus a periodic
   * sweep, so this exists for the case those don't cover: an admin who has just
   * changed something on Meta's side and wants to see it reflected NOW rather
   * than at the next sweep. Rate-limited hard because it costs two Graph reads
   * and there is no reason to press it repeatedly.
   */
  @Post("health/refresh")
  @HttpCode(200)
  @RateLimit({ perMinute: 6 })
  async refreshHealth(
    @CurrentSession() session: ApiSession,
    // `?accountId=` selects one of the workspace's numbers (same convention as
    // profile/qr-codes below); omitted polls the default number.
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.refreshHealth(session.workspaceId, accountId || null);
  }

  /**
   * Template analytics — status, and the one-time irreversible enable.
   *
   * Split into two routes on purpose. Enabling cannot be undone at Meta, so it
   * must be an explicit, confirmed action and never a side effect of the UI
   * checking whether data is available.
   */
  @Get("insights/status")
  async insightsStatus(@CurrentSession() session: ApiSession) {
    return getInsightsStatus(session.workspaceId);
  }

  @Post("insights/enable")
  @HttpCode(200)
  @RateLimit({ perMinute: 3 })
  async enableInsights(@CurrentSession() session: ApiSession) {
    return enableTemplateInsights(session.workspaceId);
  }

  /**
   * Business profile — what a customer sees when they tap the business name.
   *
   * `?accountId=` selects one of the workspace's numbers; omitted uses the
   * default. Each number has its OWN profile, so this must not be
   * workspace-global.
   */
  // Rate-limited like `health/refresh`: this costs a Graph read, and the
  // default 300/min would let one agent drive 300 calls/min at Meta against
  // the number's own budget. A lazily-opened settings panel needs single
  // digits per minute.
  @Get("profile")
  @RateLimit({ perMinute: 20 })
  async businessProfile(
    @CurrentSession() session: ApiSession,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.getBusinessProfile(session.workspaceId, accountId);
  }

  /**
   * Official Business Account standing + the WABA record. Read-only — the OBA
   * request itself is made in WhatsApp Manager.
   */
  // TWO Graph reads (the number node + the WABA node) — the same cost that
  // earned `health/refresh` a cap of 6.
  @Get("account-status")
  @RateLimit({ perMinute: 12 })
  async accountStatus(
    @CurrentSession() session: ApiSession,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.getAccountStatus(session.workspaceId, accountId);
  }

  @Post("profile")
  @HttpCode(200)
  @RateLimit({ perMinute: 12 })
  async updateBusinessProfile(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateBusinessProfileSchema)) body: UpdateBusinessProfileInput,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.updateBusinessProfile(session.workspaceId, body, accountId);
  }

  /**
   * QR codes & short links. `?accountId=` picks one of the workspace's numbers.
   * Meta caps a number at 2,000 and reports no scan analytics (a privacy
   * choice), so there is nothing to poll — these are pure CRUD.
   */
  @Get("qr-codes")
  @RateLimit({ perMinute: 20 })
  async listQrCodes(
    @CurrentSession() session: ApiSession,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.listQrCodes(session.workspaceId, accountId);
  }

  @Post("qr-codes")
  @HttpCode(200)
  @RateLimit({ perMinute: 20 })
  async createQrCode(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateQrCodeSchema)) body: CreateQrCodeInput,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.createQrCode(session.workspaceId, body, accountId);
  }

  @Post("qr-codes/:code")
  @HttpCode(200)
  @RateLimit({ perMinute: 20 })
  async updateQrCode(
    @CurrentSession() session: ApiSession,
    @Param("code") code: string,
    @Body(zBody(UpdateQrCodeSchema)) body: UpdateQrCodeInput,
    @Query("accountId") accountId?: string,
  ) {
    return this.whatsapp.updateQrCode(session.workspaceId, code, body, accountId);
  }

  /**
   * Deleting a code BREAKS any signage already printed with it — the customer
   * sees "this QR code has expired". The UI confirms before calling this.
   */
  @Delete("qr-codes/:code")
  @RateLimit({ perMinute: 20 })
  async deleteQrCode(
    @CurrentSession() session: ApiSession,
    @Param("code") code: string,
    @Query("accountId") accountId?: string,
  ) {
    await this.whatsapp.deleteQrCode(session.workspaceId, code, accountId);
    return { ok: true };
  }

  @Delete()
  async disconnect(@CurrentSession() session: ApiSession) {
    await this.whatsapp.disconnect(session.workspaceId);
    return { ok: true };
  }
}
