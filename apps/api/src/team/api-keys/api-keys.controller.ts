import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import { ApiKeysService } from "./api-keys.service";
import { CreateApiKeySchema, type CreateApiKeyInput } from "./api-keys.schemas";

/**
 * Team API keys — admin-only. These keys grant access to `/api/external/v1`,
 * which can send WhatsApp messages on behalf of the team. Issuing should
 * match the same trust level as inviting an admin.
 *
 *   GET    /api/team/api-keys           — list (never returns plaintext)
 *   POST   /api/team/api-keys           — create. Returns plaintext token ONCE.
 *   DELETE /api/team/api-keys/:id       — revoke (soft — keeps audit row)
 */
@Controller("api/team/api-keys")
@RequireRole("admin")
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const keys = await this.keys.list(session.teamId);
    return { keys };
  }

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateApiKeySchema)) body: CreateApiKeyInput,
  ) {
    return this.keys.create(session.teamId, session.userId, body);
  }

  @Delete(":id")
  async revoke(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.keys.revoke(session.teamId, id);
    return { ok: true };
  }
}
