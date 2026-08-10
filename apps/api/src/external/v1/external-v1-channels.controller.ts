import { Body, Controller, Get, Headers, Param, Post, Query, Res, UseGuards } from "@nestjs/common";

import { RateLimit } from "@/common/rate-limit.interceptor";

import { ApiKeyGuard } from "../../auth/api-key.guard";
import type { ApiKeyContext } from "../../auth/api-key.guard";
import { CurrentApiKey } from "../../auth/current-session.decorator";
import { RequireScope } from "../../auth/scope.decorator";
import { ScopeGuard } from "../../auth/scope.guard";
import { zBody } from "../../common/zod-validation.pipe";
import { streamBlob } from "@/media/stream-blob";
import { parseAccountChannel } from "@/workspace-settings/channel-accounts/channel-accounts.schemas";
import { UpdateEntryPointsSchema, UpdateInboxSourcesSchema, type UpdateEntryPointsInput, type UpdateInboxSourcesInput } from "@/workspace-settings/instagram/instagram.schemas";
import type { Response } from "express";
import { CallsService } from "@/calls/calls.service";
import { ChannelAccountsService } from "@/workspace-settings/channel-accounts/channel-accounts.service";
import { InstagramService } from "@/workspace-settings/instagram/instagram.service";

/**
 * /v1 CHANNEL ACCOUNTS + INSTAGRAM + CALLS — peeled from the ExternalV1Controller (2026-07-31 split).
 * Same base path + guard stack; check:v1-docs discovers every
 * *.controller.ts here, so a peel cannot drop a route from coverage.
 */
@Controller("api/external/v1")
@UseGuards(ApiKeyGuard, ScopeGuard)
@RateLimit({ perMinute: 600 })
export class ExternalV1ChannelsController {
  constructor(
    private readonly channelAccounts: ChannelAccountsService,
    private readonly instagram: InstagramService,
    private readonly calls: CallsService,
  ) {}

  @Get("channels/:channel/accounts")
  @RequireScope("read:channels")
  async listChannelAccounts(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("channel") channel: string,
  ) {
    const ch = parseAccountChannel(channel);
    return { accounts: await this.channelAccounts.list(auth.workspaceId, ch) };
  }

  // The same accounts across EVERY channel, display fields only.
  //
  // Needed for parity with what the inbox now shows: a conversation carries
  // `channel_connection_id` (which number/Page/handle the thread is on, and
  // therefore which one a reply goes out from), and without this an integration
  // has an opaque id and no way to resolve it. Also the only way a partner can
  // tell which number a broadcast will use before submitting it.
  //
  // No tokens, no App secret, no WABA or portfolio id — so `read:catalog`,
  // matching `whatsapp/health`, rather than the credential-adjacent
  // `read:channels` the per-channel route above uses.
  @Get("channel-accounts")
  @RequireScope("read:catalog")
  async channelAccountDirectory(@CurrentApiKey() auth: ApiKeyContext) {
    return { accounts: await this.channelAccounts.directory(auth.workspaceId) };
  }

  // ── Instagram conversation entry points ─────────────────────────────────
  // The ice breakers + persistent menu a customer sees before typing. These live
  // on META, not in our database (they can also be edited in Business Suite), so
  // both routes read and write through the same service the settings panel uses.
  //
  // `admin:settings`, not `write:channels`: this is admin-grade workspace
  // CONFIGURATION whose internal twin is `@RequireRole("admin")`, and it changes
  // what every future customer is shown — the same reasoning as assignment rules
  // and SLA policies.

  @Get("channels/instagram/entry-points")
  @RequireScope("admin:settings")
  async getInstagramEntryPoints(
    @CurrentApiKey() auth: ApiKeyContext,
    @Query("account_id") accountId?: string,
  ) {
    // `null` = we could not read them. Callers must treat that as unknown, NOT
    // as empty: POSTing an empty set back would clear a live configuration.
    return {
      entry_points: await this.instagram.getEntryPoints(
        auth.workspaceId,
        accountId?.trim() || undefined,
      ),
    };
  }

  @Post("channels/instagram/entry-points")
  @RequireScope("admin:settings")
  async setInstagramEntryPoints(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpdateEntryPointsSchema)) body: UpdateEntryPointsInput,
  ) {
    return {
      ok: true,
      entry_points: await this.instagram.setEntryPoints(auth.workspaceId, body),
    };
  }

  // ── Messenger profile: entry points, welcome screen, stickers ───────────
  // Same reasoning and the same scope as the Instagram block above. Messenger
  // has one surface Instagram does not: the WELCOME SCREEN (Get Started button,
  // greeting, commands), which Instagram's profile node rejects outright — hence
  // separate routes rather than a `channel` parameter on one.
  //
  // The sticker catalog is `read:catalog`, not `admin:settings`: it is a public,
  // read-only list of Meta's own first-party stickers with no workspace data in
  // it at all, and an integration composing a reply needs it without holding an
  // admin-grade key.

  /**
   * Which NON-DM sources reach the inbox for one Instagram account (default:
   * none — direct messages are the core and are never gated).
   *
   * `admin:settings` for the same reason as the entry points: it changes what
   * every agent in the workspace sees, and the Meta-side subscription for these
   * sources is app-wide, so this is the only per-workspace control over them.
   */
  @Post("channels/instagram/inbox-sources")
  @RequireScope("admin:settings")
  async setInstagramInboxSources(
    @CurrentApiKey() auth: ApiKeyContext,
    @Body(zBody(UpdateInboxSourcesSchema)) body: UpdateInboxSourcesInput,
  ) {
    return { ok: true, ...(await this.instagram.setInboxSources(auth.workspaceId, body)) };
  }

  // Handover Protocol. `write:conversations`, NOT `admin:settings`: unlike the
  // profile routes above this changes nothing about workspace configuration — it
  // acts on ONE conversation, and it is the programmatic equivalent of an agent
  // taking a thread over from a bot. Scoping it as an admin setting would force
  // an integration that only ever answers messages to hold an admin-grade key.
  /**
   * Stream a call's stored recording (audio/ogg). 404s until the recording
   * has been ingested (`hasRecording: true` on the call row) — recordings
   * land about a minute after the call ends.
   */
  @Get("calls/:callId/recording")
  @RequireScope("read:calls")
  async streamCallRecording(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("callId") callId: string,
    @Headers("range") range: string | undefined,
    @Res() res: Response,
  ) {
    const ref = await this.calls.getRecordingRefForTeam(auth.workspaceId, callId);
    await streamBlob(res, ref.key, range, { downloadFilename: ref.filename });
  }

  /**
   * The transcript JSON document — flat `transcript.text` plus, when speaker
   * separation succeeded, one Business/Customer turn per side in
   * `transcript.segments` (no word timings); `transcript.language` is the
   * auto-detected spoken language.
   * 404s until `hasTranscript` is true on the call row.
   */
  @Get("calls/:callId/transcript")
  @RequireScope("read:calls")
  async streamCallTranscript(
    @CurrentApiKey() auth: ApiKeyContext,
    @Param("callId") callId: string,
    @Headers("range") range: string | undefined,
    @Res() res: Response,
  ) {
    const ref = await this.calls.getTranscriptRefForTeam(auth.workspaceId, callId);
    await streamBlob(res, ref.key, range);
  }

}
