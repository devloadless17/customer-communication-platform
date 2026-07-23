import { Body, Controller, Delete, Get, Post } from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  UpdateMessengerConfigSchema,
  type UpdateMessengerConfigInput,
} from "./messenger.schemas";
import { MessengerService } from "./messenger.service";

/**
 * Facebook Messenger connection settings — admin-only.
 *
 *   GET    /api/workspace/messenger  — current config + decrypted display values
 *   POST   /api/workspace/messenger  — set/update credentials (validates Page first)
 *   DELETE /api/workspace/messenger  — disconnect (wipes secrets, keeps history)
 */
@Controller("api/workspace/messenger")
@RequireRole("admin")
export class MessengerController {
  constructor(private readonly messenger: MessengerService) {}

  @Get()
  async get(@CurrentSession() session: ApiSession) {
    const config = await this.messenger.getConfig(session.workspaceId);
    return { config };
  }

  @Post()
  async update(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateMessengerConfigSchema)) body: UpdateMessengerConfigInput,
  ) {
    const out = await this.messenger.updateConfig(session.workspaceId, body);
    return { ok: true, ...out };
  }

  @Delete()
  async disconnect(@CurrentSession() session: ApiSession) {
    await this.messenger.disconnect(session.workspaceId);
    return { ok: true };
  }
}
