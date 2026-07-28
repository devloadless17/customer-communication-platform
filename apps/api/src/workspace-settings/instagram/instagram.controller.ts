import { Body, Controller, Delete, Get, Post,
  Query,
} from "@nestjs/common";

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
 *   GET    /api/workspace/instagram  — current config + decrypted display values
 *   POST   /api/workspace/instagram  — set/update credentials (validates account first)
 *   DELETE /api/workspace/instagram  — disconnect (wipes secrets, keeps history)
 */
@Controller("api/workspace/instagram")
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

  /**
   * Removes EVERY account on this channel. `?confirmAll=1` is required when
   * the workspace holds more than one — see assertChannelDisconnectConfirmed.
   */
  @Delete()
  async disconnect(
    @CurrentSession() session: ApiSession,
    @Query("confirmAll") confirmAll?: string,
  ) {
    await this.instagram.disconnect(session.workspaceId, confirmAll === "1" || confirmAll === "true");
    return { ok: true };
  }
}
