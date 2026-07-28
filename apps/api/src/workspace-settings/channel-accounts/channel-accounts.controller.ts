import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import { SessionGuard, type ApiSession } from "../../auth/session.guard";
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
/**
 * The read-only account DIRECTORY — every member, every channel.
 *
 *   GET /api/workspace/channel-accounts
 *
 * Split from the management controller below on purpose: that one decrypts and
 * mutates credentials and is admin-only, while this returns display fields an
 * AGENT needs to know which number a conversation came in on. Same guard as any
 * other inbox read; nothing sensitive crosses the wire (see
 * `ChannelAccountDirectoryEntry`).
 */
@Controller("api/workspace/channel-accounts")
// Explicit, because this controller has no @RequireRole to imply it: the
// directory is readable by every MEMBER, so the role guard that carries the
// session chain on the admin controller below is deliberately absent here.
// Without this the route 401s for a perfectly valid session — and the inbox
// layout's `.catch(() => [])` swallowed it, so the account chip silently never
// rendered rather than failing loudly.
@UseGuards(SessionGuard)
export class ChannelAccountDirectoryController {
  constructor(private readonly accounts: ChannelAccountsService) {}

  @Get()
  async directory(@CurrentSession() session: ApiSession) {
    return { accounts: await this.accounts.directory(session.workspaceId) };
  }
}

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

  /**
   * What the CHANNEL-level disconnect would break. That button removes every
   * account on the channel, so its confirm dialog needs whole-channel numbers —
   * the per-account route below speaks for one row only.
   *
   * Declared before `:id/removal-impact`; the paths are unambiguous (there is
   * no bare `@Get(":id")`) but keeping them adjacent makes the pair obvious.
   */
  @Get("removal-impact")
  async channelRemovalImpact(
    @CurrentSession() session: ApiSession,
    @Param("channel") channel: string,
  ) {
    const ch = parseAccountChannel(channel);
    return this.accounts.channelRemovalImpact(session.workspaceId, ch);
  }

  /**
   * What disconnecting would break — read BEFORE the destructive call so the
   * confirm dialog can be specific instead of vague.
   */
  @Get(":id/removal-impact")
  async removalImpact(
    @CurrentSession() session: ApiSession,
    @Param("channel") channel: string,
    @Param("id") id: string,
  ) {
    const ch = parseAccountChannel(channel);
    return this.accounts.removalImpact(session.workspaceId, ch, id);
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
