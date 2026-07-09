import { Body, Controller, Delete, Get, Post } from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  UpdateMetaConnectionSchema,
  type UpdateMetaConnectionInput,
} from "./meta.schemas";
import { MetaService } from "./meta.service";

/**
 * Shared Meta-app credentials — admin-only. Set once; every Meta channel reads
 * from it.
 *
 *   GET    /api/team/meta  — current shared config + decrypted display values
 *   POST   /api/team/meta  — set/update the App secret + system-user token
 *   DELETE /api/team/meta  — clear the shared connection
 */
@Controller("api/team/meta")
@RequireRole("admin")
export class MetaController {
  constructor(private readonly meta: MetaService) {}

  @Get()
  async get(@CurrentSession() session: ApiSession) {
    const config = await this.meta.getConfig(session.teamId);
    return { config };
  }

  @Post()
  async update(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateMetaConnectionSchema)) body: UpdateMetaConnectionInput,
  ) {
    const out = await this.meta.updateConfig(session.teamId, body);
    return { ok: true, ...out };
  }

  @Delete()
  async disconnect(@CurrentSession() session: ApiSession) {
    await this.meta.disconnect(session.teamId);
    return { ok: true };
  }
}
