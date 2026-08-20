import { Body, Controller, Delete, Get, Param, Post } from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { RateLimit } from "../../common/rate-limit.interceptor";
import { zBody } from "../../common/zod-validation.pipe";
import { DbService } from "../../db/db.service";
import { recordOperatorAction } from "@/lib/workspaces/operator-log";
import { ApiKeysService } from "./api-keys.service";
import { CreateApiKeySchema, type CreateApiKeyInput } from "./api-keys.schemas";

/**
 * Team API keys — admin-only. These keys grant access to `/api/external/v1`,
 * which can send WhatsApp messages on behalf of the team. Issuing should
 * match the same trust level as inviting an admin.
 *
 *   GET    /api/workspace/api-keys             — list (never returns plaintext)
 *   POST   /api/workspace/api-keys             — create. Returns plaintext token ONCE.
 *   POST   /api/workspace/api-keys/:id/rotate  — revoke + recreate with same name+scopes.
 *                                            Returns the NEW plaintext ONCE.
 *   DELETE /api/workspace/api-keys/:id         — revoke (soft — keeps audit row)
 */
@Controller("api/workspace/api-keys")
@RequireRole("admin")
export class ApiKeysController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly db: DbService,
  ) {}

  @Get()
  async list(@CurrentSession() session: ApiSession) {
    const keys = await this.keys.list(session.workspaceId);
    return { keys };
  }

  @Post()
  async create(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreateApiKeySchema)) body: CreateApiKeyInput,
  ) {
    // OPERATOR ACTION LOG (CLAUDE.md §18): a key is a lasting credential to the
    // tenant's data, so an operator minting one is recorded — awaited BEFORE
    // the mint, so a failed record fails the action, never the other way round.
    if (session.isOperator) {
      await recordOperatorAction(this.db, {
        userId: session.userId,
        workspaceId: session.workspaceId,
        action: "api_key_create",
        detail: { name: body.name },
      });
    }
    return this.keys.create(session.workspaceId, session.userId, body);
  }

  @Post(":id/rotate")
  // Tight bucket vs the global 300/min/user default — rotate generates a new
  // plaintext token and revokes the old one in one shot. A stolen session
  // firing rotate at the global ceiling could thrash a partner integration
  // 300 times per minute. 10/min covers the legitimate operator cadence
  // (clicking rotate every few seconds while debugging) with comfortable
  // headroom; abuse trips the bucket loudly.
  @RateLimit({ perMinute: 10 })
  async rotate(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    // A rotation mints a new plaintext token too — same accountability as create.
    if (session.isOperator) {
      await recordOperatorAction(this.db, {
        userId: session.userId,
        workspaceId: session.workspaceId,
        action: "api_key_create",
        detail: { rotatedKeyId: id },
      });
    }
    return this.keys.rotate(session.workspaceId, session.userId, id);
  }

  @Delete(":id")
  async revoke(
    @CurrentSession() session: ApiSession,
    @Param("id") id: string,
  ) {
    await this.keys.revoke(session.workspaceId, id);
    return { ok: true };
  }
}
