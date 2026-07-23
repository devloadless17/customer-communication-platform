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
 *   GET    /api/workspace/meta  — current shared config + decrypted display values
 *   POST   /api/workspace/meta  — set/update the App secret + system-user token
 *   DELETE /api/workspace/meta  — clear the shared connection
 */
@Controller("api/workspace/meta")
@RequireRole("admin")
export class MetaController {
  constructor(private readonly meta: MetaService) {}

  @Get()
  async get(@CurrentSession() session: ApiSession) {
    const config = await this.meta.getConfig(session.workspaceId);
    return { config };
  }

  @Post()
  async update(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateMetaConnectionSchema)) body: UpdateMetaConnectionInput,
  ) {
    const out = await this.meta.updateConfig(session.workspaceId, body);
    return { ok: true, ...out };
  }

  @Delete()
  async disconnect(@CurrentSession() session: ApiSession) {
    await this.meta.disconnect(session.workspaceId);
    return { ok: true };
  }
}
