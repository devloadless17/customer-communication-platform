import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import { ChannelAccountsService } from "./channel-accounts.service";
import {
  parseAccountChannel,
  RenameAccountSchema,
  type RenameAccountInput,
} from "./channel-accounts.schemas";

/**
 * Multiple accounts per channel — admin-only.
 *
 *   GET    /api/workspace/channels/:channel/accounts
 *   PATCH  /api/workspace/channels/:channel/accounts/:id        — rename
 *   POST   /api/workspace/channels/:channel/accounts/:id/default
 *   DELETE /api/workspace/channels/:channel/accounts/:id        — disconnect
 *
 * ADDING an account is not here: it's the existing per-channel connect flow
 * (POST /api/workspace/whatsapp etc.), which upserts keyed on the provider's account
 * id — so pasting a second number's credentials creates a second account rather
 * than overwriting the first.
 */
@Controller("api/workspace/channels/:channel/accounts")
@RequireRole("admin")
export class ChannelAccountsController {
  constructor(private readonly accounts: ChannelAccountsService) {}

  @Get()
  async list(@CurrentSession() session: ApiSession, @Param("channel") channel: string) {
    const ch = parseAccountChannel(channel);
    return { accounts: await this.accounts.list(session.workspaceId, ch) };
  }

  @Patch(":id")
  async rename(
    @CurrentSession() session: ApiSession,
    @Param("channel") channel: string,
    @Param("id") id: string,
    @Body(zBody(RenameAccountSchema)) body: RenameAccountInput,
  ) {
    const ch = parseAccountChannel(channel);
    await this.accounts.rename(session.workspaceId, ch, id, body.label);
    return { ok: true };
  }

  @Post(":id/default")
  async setDefault(
    @CurrentSession() session: ApiSession,
    @Param("channel") channel: string,
    @Param("id") id: string,
  ) {
    const ch = parseAccountChannel(channel);
    await this.accounts.setDefault(session.workspaceId, ch, id);
    return { ok: true };
  }

  @Delete(":id")
  async remove(
    @CurrentSession() session: ApiSession,
    @Param("channel") channel: string,
    @Param("id") id: string,
  ) {
    const ch = parseAccountChannel(channel);
    await this.accounts.remove(session.workspaceId, ch, id);
    return { ok: true };
  }
}
