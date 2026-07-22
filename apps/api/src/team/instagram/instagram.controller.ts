import { Body, Controller, Delete, Get, Post } from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  UpdateInstagramConfigSchema,
  type UpdateInstagramConfigInput,
} from "./instagram.schemas";
import { InstagramService } from "./instagram.service";

/**
 * Instagram DM connection settings — admin-only.
 *
 *   GET    /api/team/instagram  — current config + decrypted display values
 *   POST   /api/team/instagram  — set/update credentials (validates account first)
 *   DELETE /api/team/instagram  — disconnect (wipes secrets, keeps history)
 */
@Controller("api/team/instagram")
@RequireRole("admin")
export class InstagramController {
  constructor(private readonly instagram: InstagramService) {}

  @Get()
  async get(@CurrentSession() session: ApiSession) {
    const config = await this.instagram.getConfig(session.workspaceId);
    return { config };
  }

  @Post()
  async update(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateInstagramConfigSchema)) body: UpdateInstagramConfigInput,
  ) {
    const out = await this.instagram.updateConfig(session.workspaceId, body);
    return { ok: true, ...out };
  }

  @Delete()
  async disconnect(@CurrentSession() session: ApiSession) {
    await this.instagram.disconnect(session.workspaceId);
    return { ok: true };
  }
}
