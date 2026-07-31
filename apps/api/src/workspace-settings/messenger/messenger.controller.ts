import { Body, Controller, Delete, Get, Param, Post,
  Query,
} from "@nestjs/common";

import { CurrentSession } from "../../auth/current-session.decorator";
import { RequireRole } from "../../auth/role.guard";
import type { ApiSession } from "../../auth/session.guard";
import { zBody, zQuery } from "../../common/zod-validation.pipe";
import {
  CreatePersonaSchema,
  StickerCatalogQuerySchema,
  ThreadControlSchema,
  UpdateMessengerConfigSchema,
  UpdateMessengerEntryPointsSchema,
  UpdateMessengerWelcomeSchema,
  type CreatePersonaInput,
  type StickerCatalogQuery,
  type ThreadControlInput,
  type UpdateMessengerConfigInput,
  type UpdateMessengerEntryPointsInput,
  type UpdateMessengerWelcomeInput,
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

  /**
   * The Messenger Profile surfaces. Both read Meta live (no local mirror — see
   * `MessengerService.getEntryPoints`), and both accept `?accountId=` to target
   * one connected Page; omitted means the default. A `null` body means we could
   * not read it — the UI must say so rather than render an empty editor, whose
   * next save would clear a live configuration.
   */
  @Get("entry-points")
  async getEntryPoints(
    @CurrentSession() session: ApiSession,
    @Query("accountId") accountId?: string,
  ) {
    const entryPoints = await this.messenger.getEntryPoints(
      session.workspaceId,
      accountId?.trim() || undefined,
    );
    return { entryPoints };
  }

  @Post("entry-points")
  async setEntryPoints(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateMessengerEntryPointsSchema)) body: UpdateMessengerEntryPointsInput,
  ) {
    const entryPoints = await this.messenger.setEntryPoints(session.workspaceId, body);
    return { ok: true, entryPoints };
  }

  @Get("welcome")
  async getWelcome(
    @CurrentSession() session: ApiSession,
    @Query("accountId") accountId?: string,
  ) {
    const welcome = await this.messenger.getWelcome(
      session.workspaceId,
      accountId?.trim() || undefined,
    );
    return { welcome };
  }

  @Post("welcome")
  async setWelcome(
    @CurrentSession() session: ApiSession,
    @Body(zBody(UpdateMessengerWelcomeSchema)) body: UpdateMessengerWelcomeInput,
  ) {
    const welcome = await this.messenger.setWelcome(session.workspaceId, body);
    return { ok: true, welcome };
  }

  /**
   * First-party sticker catalog: packs by default, one pack's stickers with
   * `?packId=`, or a keyword search with `?q=`. `null` means the catalog is
   * unavailable (no app credentials on the connection, or Graph refused) — the
   * picker falls back to the always-sendable like sticker.
   */
  @Get("stickers")
  async stickers(
    @CurrentSession() session: ApiSession,
    @Query(zQuery(StickerCatalogQuerySchema)) query: StickerCatalogQuery,
  ) {
    return { catalog: await this.messenger.stickers(session.workspaceId, query) };
  }

  /**
   * Handover Protocol. `take` claims the thread (primary receiver only),
   * `request` asks the primary receiver for it, `pass` gives it away (default
   * target: Meta's Page Inbox), `release` returns it.
   *
   * The response's `ownerAppId` is re-read from Meta — for `request` especially,
   * a 200 does NOT mean the thread is ours.
   */
  @Post("thread-control")
  async threadControl(
    @CurrentSession() session: ApiSession,
    @Body(zBody(ThreadControlSchema)) body: ThreadControlInput,
  ) {
    return { ok: true, ...(await this.messenger.threadControl(session.workspaceId, body)) };
  }

  @Get("thread-owner")
  async threadOwner(
    @CurrentSession() session: ApiSession,
    @Query("psid") psid: string,
    @Query("accountId") accountId?: string,
  ) {
    return {
      ownerAppId: await this.messenger.threadOwner(
        session.workspaceId,
        psid,
        accountId?.trim() || undefined,
      ),
    };
  }

  /**
   * Personas — the named voices a reply can be sent under. Read live from Meta;
   * `null` means we could not ask, not "none exist".
   */
  @Get("personas")
  async personas(
    @CurrentSession() session: ApiSession,
    @Query("accountId") accountId?: string,
  ) {
    return {
      personas: await this.messenger.personas(
        session.workspaceId,
        accountId?.trim() || undefined,
      ),
    };
  }

  @Post("personas")
  async createPersona(
    @CurrentSession() session: ApiSession,
    @Body(zBody(CreatePersonaSchema)) body: CreatePersonaInput,
  ) {
    return { ok: true, persona: await this.messenger.createPersona(session.workspaceId, body) };
  }

  /** SOFT delete — history is preserved; only future sends are blocked. */
  @Delete("personas/:personaId")
  async deletePersona(
    @CurrentSession() session: ApiSession,
    @Param("personaId") personaId: string,
    @Query("accountId") accountId?: string,
  ) {
    await this.messenger.deletePersona(
      session.workspaceId,
      personaId,
      accountId?.trim() || undefined,
    );
    return { ok: true };
  }

  /**
   * The Page's approved UTILITY templates — the only send that reaches a customer
   * outside the 24h window. `null` = could not read, which is NOT the same as
   * "this Page has none".
   */
  @Get("utility-templates")
  async utilityTemplates(
    @CurrentSession() session: ApiSession,
    @Query("accountId") accountId?: string,
  ) {
    return {
      templates: await this.messenger.utilityTemplates(
        session.workspaceId,
        accountId?.trim() || undefined,
      ),
    };
  }

  /**
   * Campaign reach across every connected Page. `?templateName=` additionally
   * reports which Pages have that template approved — a utility template is
   * Page-OWNED, so one approved on Page A does not exist on Page B and its name
   * fails there per-recipient. `hasTemplate: null` means we could not read that
   * Page's library, which is NOT the same as missing.
   */
  @Get("broadcast-reach")
  async broadcastReach(
    @CurrentSession() session: ApiSession,
    @Query("templateName") templateName?: string,
  ) {
    return this.messenger.broadcastReach(
      session.workspaceId,
      templateName?.trim() || undefined,
    );
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
    await this.messenger.disconnect(session.workspaceId, confirmAll === "1" || confirmAll === "true");
    return { ok: true };
  }
}
