import { Body, Controller, Delete, Get, Post,
  Query,
} from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody } from "../../common/zod-validation.pipe";
import {
  UpdateEntryPointsSchema,
  UpdateInboxSourcesSchema,
  UpdateInstagramConfigSchema,
  type UpdateEntryPointsInput,
  type UpdateInboxSourcesInput,
  type UpdateInstagramConfigInput,
} from "./instagram.schemas";
import { InstagramService } from "./instagram.service";

/**
 * Instagram DM connection settings — admin-only.
 *
 *   GET    /api/workspace/instagram              — current config + decrypted display values
 *   POST   /api/workspace/instagram              — set/update credentials (validates account first)
 *   DELETE /api/workspace/instagram              — disconnect (wipes secrets, keeps history)
 *   GET    /api/workspace/instagram/entry-points — live ice breakers + persistent menu
 *   POST   /api/workspace/instagram/entry-points — replace them (empty list clears)
 *
 * The entry-point routes read and write META, not our database — see
 * `InstagramService.getEntryPoints` for why there is deliberately no local mirror.
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
   * The ice breakers + persistent menu currently live on Meta for one account
   * (`?accountId=` — omitted means the default). `entryPoints: null` means we
   * could not read them; the panel must NOT render an empty editor for that,
   * because saving it would clear a live configuration.
   */
  @Get("entry-points")
  async getEntryPoints(
    @CurrentSession() session: ApiSession,
    @Query("accountId") accountId?: string,
  ) {
    const entryPoints = await this.instagram.getEntryPoints(
      session.workspaceId,
      accountId?.trim() || undefined,
    );
    return { entryPoints };
  }

  @Post("entry-points")
  async setEntryPoints(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateEntryPointsSchema)) body: UpdateEntryPointsInput,
  ) {
    const entryPoints = await this.instagram.setEntryPoints(session.workspaceId, body);
    return { ok: true, entryPoints };
  }

  /**
   * Which NON-DM sources reach the inbox for one account. Direct messages are
   * never listed — they are the core and are always on. Defaults to none.
   */
  @Post("inbox-sources")
  async setInboxSources(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateInboxSourcesSchema)) body: UpdateInboxSourcesInput,
  ) {
    return { ok: true, ...(await this.instagram.setInboxSources(session.workspaceId, body)) };
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
