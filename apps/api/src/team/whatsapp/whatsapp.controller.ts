import { Body, Controller, Delete, Get, Post } from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  UpdateWhatsappConfigSchema,
  type UpdateWhatsappConfigInput,
} from "./whatsapp.schemas";
import { WhatsappService } from "./whatsapp.service";

/**
 * WhatsApp Cloud API connection settings — admin-only.
 *
 *   GET    /api/team/whatsapp    — current config + decrypted display values
 *                                  (admin form pre-fill — see service for
 *                                  the security tradeoff around exposing
 *                                  plaintext secrets to the admin's browser)
 *   POST   /api/team/whatsapp    — set/update credentials (validates against Meta first)
 *   DELETE /api/team/whatsapp    — disconnect (wipes secrets, keeps history)
 *
 * Template endpoints live in WhatsappTemplatesController (any agent on the
 * team can refresh/create/delete — templates are catalog data, not secret
 * state).
 */
@Controller("api/team/whatsapp")
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

  @Delete()
  async disconnect(@CurrentSession() session: ApiSession) {
    await this.whatsapp.disconnect(session.workspaceId);
    return { ok: true };
  }
}
