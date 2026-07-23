import { Body, Controller, Delete, Get, HttpCode, Post } from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RateLimit } from "../../common/rate-limit.interceptor";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  UpdateWhatsappConfigSchema,
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
  async refreshHealth(@CurrentSession() session: ApiSession) {
    return this.whatsapp.refreshHealth(session.workspaceId);
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

  @Delete()
  async disconnect(@CurrentSession() session: ApiSession) {
    await this.whatsapp.disconnect(session.workspaceId);
    return { ok: true };
  }
}
