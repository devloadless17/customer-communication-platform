import { Prisma } from "@prisma/client";

import { runWithConcurrency } from "@/common/concurrency";
import { blobStorage } from "@/lib/blob-storage";
import { reconcileInboundMediaMime } from "@/lib/blob-storage/mime-guard";
import { publish } from "@/lib/events/bus";
import { MEDIA_SIZE_CAPS, mediaPolicyForChannel } from "@/lib/media-storage";
import {
  extractImageThumbnail,
  extractVideoPosterFrame,
  probeMediaDurationMs,
} from "@/lib/media-thumbnail";
import { getMetaProvider } from "@/lib/providers";
import { MediaTooLargeError, scanWhatsappEnvelope } from "@/lib/providers/meta";
import {
  groupEventsByInboundAccount,
  resolveInboundAccounts,
} from "@/lib/providers/inbound-accounts";
import type { InboundAccountGroup } from "@/lib/providers/inbound-accounts";
import { getMetaSendConfig } from "@/lib/providers/config";
import { messengerProvider } from "@/lib/providers/messenger";
import { getMessengerWebhookConfig } from "@/lib/providers/messenger-config";
import { instagramProvider } from "@/lib/providers/instagram";
import {
  getInstagramInboxSources,
  getInstagramWebhookConfig,
} from "@/lib/providers/instagram-config";
import {
  enrichSocialContactNames,
  ingestEvents,
  isTransientDbError,
} from "@/lib/providers/ingest";
import { enqueueHistoryChunk } from "@/lib/coexistence/history-queue";
import { fetchUrlBytes, withMediaDownloadSlot } from "@/lib/media-capture";
import type { NormalizedEvent } from "@ccp/shared/providers/types";
import type { Channel, MediaKind } from "@ccp/shared/types";
import {
  channelInboxSources,
  inboxSourceOfStructuredKind,
  type InboxSource,
} from "@ccp/shared/providers/capabilities";
import { mediaPreviewLabel } from "@ccp/shared/types";


import { Injectable, Logger, ServiceUnavailableException, type OnModuleDestroy } from "@nestjs/common";

import { DbService } from "../../db/db.service";

/**
 * The webhook INGEST half of the Meta callback, split out of
 * `MetaWebhookController` (2026-07-31): the controller owns routing + HMAC
 * authentication and nothing else; everything after "the payload is trusted"
 * — dedup, the Coexistence history diversion, per-account grouping, media
 * download/thumbnail/duration, and the transient-503 vs permanent-200 split —
 * lives here, callable from both the per-workspace and the app-level route so
 * the two callbacks cannot drift (the same reason the methods were shared
 * private helpers before the split; now the seam is a real layer boundary).
 *
 * Every public method TRUSTS its payload — callers MUST have verified the
 * HMAC first.
 */

/**
 * The NON-DM source this parsed event came from, or null when it is an ordinary
 * direct message.
 *
 * A comment rides the ordinary inbound-message shape (that is the whole point —
 * it reuses contact/conversation/realtime with no second entity), so the only
 * honest discriminator is its structured payload. The kind→source mapping itself
 * lives in `@ccp/shared` so the gate below and every future reader agree.
 */
function nonDmSourceOf(evt: NormalizedEvent): InboxSource | null {
  if (evt.kind !== "message") return null;
  return inboxSourceOfStructuredKind(evt.structured?.kind);
}

/** The provider + webhook-config loader for a social (non-WhatsApp) channel. */
/** The provider + webhook-config loader for a social (non-WhatsApp) channel. */
export const SOCIAL = {
  messenger: { provider: messengerProvider, getWebhookConfig: getMessengerWebhookConfig },
  instagram: { provider: instagramProvider, getWebhookConfig: getInstagramWebhookConfig },
} as const;

/**
 * Per-event outcome of the inbound-media download. Kept OUT of the event
 * object on purpose: `evt.media` is the parser's view (what Meta said the
 * binary is), and any concurrent mutation of it races with `ingestEvents`
 * which reads `storageKey`/`storageUrl` synchronously inside its own
 * transaction. Storing outcomes in a separate Map breaks the reference so
 * the download path can keep writing while ingest reads its frozen input.
 */
type DownloadOutcome =
  | {
      ok: true;
      storageKey: string;
      storageUrl: string;
      sizeBytes: number;
      mimeType: string;
      thumbnailStorageKey?: string;
      thumbnailStorageUrl?: string;
      // Probed from the bytes for inbound audio/voice (the WhatsApp webhook
      // carries no duration) so the bubble shows the length up front like real
      // WhatsApp. Undefined for other kinds / when the probe fails.
      durationMs?: number;
    }
  // `retriable` tells `completePendingMedia` whether to clear the row to
  // text-only NOW (permanent failure — re-downloading can't help) or PARK it
  // in the media-pending state so the inbound-media sweeper re-attempts the
  // download over a longer horizon (transient failure — a Meta-CDN / blob blip
  // that the bytes, retained by Meta for ~30 days, would survive). Without this
  // split, a single transient blip stripped media permanently.
  | { ok: false; retriable: boolean };

@Injectable()
export class MetaWebhookIngestService implements OnModuleDestroy {
  private readonly logger = new Logger(MetaWebhookIngestService.name);
  // In-flight inbound-media completions. Tracked so a SIGTERM mid-download
  // doesn't abandon the row patch — an abandoned row stays media-pending and
  // the inbound-media sweeper later CLEARS it to text-only (the binary is lost;
  // Meta media URLs expire). Drained, bounded, in onModuleDestroy.
  private readonly inFlightMedia = new Set<Promise<void>>();

  constructor(private readonly db: DbService) {}

  /**
   * Drain in-flight inbound-media completions on shutdown so the in-flight
   * ones finish their Meta download + blob upload + row patch instead of being
   * abandoned (→ sweeper clears them → media lost). Bounded so a single stuck
   * download can't blow the shutdown budget; on timeout the sweeper is the
   * backstop (same as today, but we tried). Part of the sequential
   * OnModuleDestroy chain capped by main.ts's app.close() budget.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.inFlightMedia.size === 0) return;
    const DRAIN_TIMEOUT_MS = 15_000;
    this.logger.log(
      `draining ${this.inFlightMedia.size} in-flight inbound-media completion(s)`,
    );
    await Promise.race([
      Promise.allSettled([...this.inFlightMedia]),
      new Promise<void>((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS).unref()),
    ]);
  }

  /**
   * Ingest a VERIFIED WhatsApp payload for a known workspace.
   *
   * Split out from the route so the per-workspace callback
   * (`/webhooks/meta/:workspaceId`) and the app-level callback (`/webhooks/meta`,
   * where the tenant is resolved from the payload) share ONE implementation.
   * Everything load-bearing lives here — dedup, the Coexistence history diversion,
   * per-account grouping, media download, and the transient-503 vs permanent-200
   * split — so the two routes cannot drift into disagreeing about any of it
   * (CLAUDE.md §17: don't invent a parallel pattern).
   *
   * Callers MUST have verified the HMAC first. This function trusts the payload.
   */
  async ingestWhatsappPayload(
    workspaceId: string,
    payload: unknown,
  ): Promise<{ ok: boolean; ingested?: number; dropped?: string }> {

    // One cheap wire-shape walk for the two decisions we make BEFORE parsing:
    // is this a (potentially huge) Coexistence history chunk, and does this
    // workspace own any of the numbers it names?
    //
    // Note what is NOT here any more: a single account resolved for the whole
    // body. Meta batches changes for SEVERAL of a workspace's numbers into one
    // POST, so attribution happens per event, after the parse
    // (`groupEventsByInboundAccount`). HMAC against the workspace's account
    // secrets remains the only authentication; these ids are a routing signal.
    const { hasHistory, accountIds } = scanWhatsappEnvelope(payload);

    // WhatsApp Coexistence history backfill. The `history` webhook can carry
    // thousands of past messages across chunked deliveries — far too much to
    // ingest inline within the fail-soft budget. Detect it, hand the RAW payload
    // to the coexistence-history BullMQ worker, and 200 immediately. The worker
    // re-parses + ingests quietly (no unread bump / no automation fanout), and
    // resolves each event's OWN account. Live message/echo/state-sync webhooks
    // fall through to the fast inline path below. A history webhook is its own
    // delivery (Meta doesn't mix history with live messages), so treating any
    // history-bearing payload as a backfill chunk is safe.
    if (hasHistory) {
      // Keep the pre-enqueue gate: a payload naming only numbers we don't hold
      // never enters Redis. If it names SOME we hold, enqueue — the worker drops
      // the unknown events per-event rather than losing the known ones.
      if (accountIds.length > 0) {
        const known = await resolveInboundAccounts(workspaceId, "whatsapp", accountIds);
        if (known.size === 0) {
          this.logger.warn(
            `[${workspaceId}] history payload names no connected account — dropping`,
          );
          return { ok: true, ingested: 0, dropped: "unknown_account" };
        }
      }
      try {
        await enqueueHistoryChunk(workspaceId, payload);
        return { ok: true, ingested: 0 };
      } catch (err) {
        // Redis down / enqueue failed → 503 so Meta redelivers the chunk (the
        // worker dedups by wamid, so a redelivery is safe). Better than dropping
        // history the customer can never re-fetch.
        this.logger.error(`[${workspaceId}] failed to enqueue history chunk`, err);
        throw new ServiceUnavailableException("history enqueue failed");
      }
    }

    // Fail SOFT — `parseWebhook` iterates Meta's array fields, and a future
    // Meta shape where one of those fields arrives as a non-array would make
    // the walk throw a TypeError on an HMAC-valid body. A 500 here puts us in
    // an infinite per-team retry storm (Meta retries any non-2xx). Log loudly,
    // drop the batch, and return 200 to bound the damage.
    let events: NormalizedEvent[];
    try {
      events = getMetaProvider().parseWebhook(payload);
    } catch (err) {
      this.logger.error(`[${workspaceId}] webhook parse failed; dropping batch`, err);
      return { ok: true, ingested: 0, dropped: "parse_failed" };
    }
    if (events.length === 0) return { ok: true, ingested: 0 };

    // Partition by the account each event ACTUALLY arrived on. One POST can
    // legitimately carry traffic for several of this workspace's numbers, and
    // stamping all of it with one account re-pointed the sibling's threads (so
    // the next reply went out a number with no open 24h window). Groups are
    // ingested sequentially — see the module docstring for why that matters.
    const { groups, dropped } = await groupEventsByInboundAccount(
      workspaceId,
      "whatsapp",
      events,
    );
    for (const d of dropped) {
      this.logger.warn(
        `[${workspaceId}] dropped ${d.count} whatsapp event(s): ${d.reason}` +
          (d.externalAccountId ? ` (phone_number_id=${d.externalAccountId})` : ""),
      );
    }
    if (groups.length === 0) {
      // Nothing attributable — same wire shape the single-account check returned.
      return { ok: true, ingested: 0, dropped: "unknown_account" };
    }

    // Fully-async media flow. Kick off binary downloads in background and
    // commit the rows immediately as `mediaPending`. The bubble appears in
    // the agent's inbox in <100ms with a shimmer; `completePendingMedia`
    // patches the row + emits `message:media_ready` once bytes land,
    // swapping the shimmer for the image.
    //
    // Earlier versions raced the download against a 500ms in-band budget so
    // the happy path could ingest with media columns populated and save one
    // UPDATE. The race added a hard 500ms floor on every media-bearing
    // webhook (and made text bubbles in mixed batches wait too) — the floor
    // is the wrong tradeoff for "instant" perceived UX. Cost is now one
    // extra UPDATE per inbound media row; benefit is sub-100ms bubble paint
    // for every inbound, mirroring WhatsApp Web behavior.
    //
    // Outcomes live in `downloadOutcomes` (NOT on `evt.media`). The download
    // task writes outcomes as each event completes; `completePendingMedia`
    // reads the map after `downloadPromise` settles.
    //
    // One download task PER GROUP: a Meta media id is scoped to the account that
    // received it, so each group's binaries must be fetched with that account's
    // token. Outcomes share one map — keys are `externalId`, which is globally
    // unique — so `completePendingMedia` still sees every event's result.
    const downloadOutcomes = new Map<string, DownloadOutcome>();
    const downloadPromise = Promise.all(
      groups.map((g) =>
        this.downloadInboundMedia(workspaceId, g.events, downloadOutcomes, g.channelConnectionId),
      ),
    ).then(() => undefined);
    // The ingest-failure branches below return/throw WITHOUT ever consuming
    // `downloadPromise` (only the success path threads it into
    // `completePendingMedia`). A rejection on that orphaned promise would
    // surface as an unhandledRejection. Attach a non-consuming handler so it
    // can never float — the original promise is unchanged, so the success
    // path's `await downloadPromise` still observes the real settlement.
    downloadPromise.catch((err) =>
      this.logger.error(`[${workspaceId}] inbound media download failed`, err),
    );

    // Sequential, in payload order. A transient DB fault throws 503 from inside
    // `ingestGroup` so Meta redelivers the whole POST — safe because every event
    // is deduped on (workspaceId, channel, externalId), so already-landed groups
    // re-run as no-ops.
    let ingested = 0;
    for (const group of groups) {
      if (await this.ingestGroup(workspaceId, "whatsapp", group)) {
        ingested += group.events.length;
      }
    }
    if (ingested === 0) return { ok: true, ingested: 0, dropped: "ingest_failed" };

    // Background-only: every media-bearing event waits for downloadPromise
    // then patches + emits. No-op when the batch has no media (the helper
    // filters internally). Tracked in `inFlightMedia` so onModuleDestroy can
    // drain it on shutdown rather than letting a SIGTERM abandon the patch.
    const completion = this.completePendingMedia(
      workspaceId,
      events,
      downloadPromise,
      downloadOutcomes,
    ).catch((err) =>
      this.logger.error(`[${workspaceId}] background media completion failed`, err),
    );
    this.inFlightMedia.add(completion);
    void completion.finally(() => this.inFlightMedia.delete(completion));

    return {
      ok: true,
      ingested,
      // Some groups landed, others named accounts we don't hold. Distinct from
      // the all-unknown case above so an operator can tell "wrong tenant" from
      // "one stale number still subscribed at Meta".
      ...(dropped.length > 0 ? { dropped: "partial_unknown_account" } : {}),
    };
  }

  /**
   * Ingest ONE account group.
   *
   * Returns false when the group was permanently dropped; throws
   * ServiceUnavailable on a transient DB fault so Meta redelivers the whole POST.
   * Redelivery is safe: every event is deduped on
   * (workspaceId, channel, externalId), so groups that already landed re-run as
   * no-ops.
   *
   * Both inbound paths funnel through here so the fail-soft contract — 503 for
   * transient, 200-dropped for permanent — has exactly one definition instead of
   * being copied per channel.
   */
  private async ingestGroup(
    workspaceId: string,
    channel: Channel,
    group: InboundAccountGroup,
  ): Promise<boolean> {
    try {
      await ingestEvents(workspaceId, channel, group.events, group.channelConnectionId);
      return true;
    } catch (err) {
      // Meta retries on any non-2xx. Map error classes to the response that
      // actually matches the intent:
      //   - Transient DB pressure (pool timeout / serialization) → 503 so
      //     Meta retries after backoff.
      //   - Anything else (parse drift, invariant violations) → drop. Meta
      //     retrying a permanently-bad payload forever drains both sides;
      //     the raw payload can be replayed manually if it matters.
      if (isTransientDbError(err)) {
        // Label the actual cause: driver-level faults (pool exhaustion, socket
        // resets) are neither a Prisma error code nor an init error, and calling
        // them "init" sent incident triage down the wrong path.
        const code =
          err instanceof Prisma.PrismaClientKnownRequestError
            ? err.code
            : err instanceof Prisma.PrismaClientInitializationError
              ? "init"
              : `driver:${String((err as { code?: unknown })?.code ?? "timeout")}`;
        this.logger.warn(
          `[${workspaceId}] transient ${channel} ingest failure (${code}); asking Meta to retry`,
        );
        throw new ServiceUnavailableException("transient ingest failure");
      }
      this.logger.error(
        `[${workspaceId}] permanent ${channel} ingest failure; dropping ${group.events.length} event(s)` +
          (group.externalAccountId ? ` for account ${group.externalAccountId}` : ""),
        err,
      );
      return false;
    }
  }


  /**
   * Ingest a VERIFIED Messenger/Instagram payload for a known workspace. Shared by
   * the per-workspace and app-level callbacks — see `ingestWhatsappPayload`.
   */
  async ingestSocialPayload(
    workspaceId: string,
    channel: "messenger" | "instagram",
    payload: unknown,
  ): Promise<{ ok: boolean; ingested?: number; dropped?: string }> {
    const { provider } = SOCIAL[channel];

    let events: NormalizedEvent[];
    try {
      events = provider.parseWebhook(payload);
    } catch (err) {
      this.logger.error(`[${workspaceId}] ${channel} webhook parse failed; dropping batch`, err);
      return { ok: true, ingested: 0, dropped: "parse_failed" };
    }
    if (events.length === 0) return { ok: true, ingested: 0 };

    // Partition by the receiving Page / IG account. The parser stamps
    // `entry[].id` per entry, and Meta may batch entries for several of this
    // workspace's accounts into one POST — the old single-account resolve bound
    // the second Page's threads to the first.
    //
    // A payload carrying no `entry[].id` no longer falls back to the DEFAULT
    // account: that is a SEND preference, and using it to attribute inbound bound
    // a thread to a Page the customer never messaged. Account-bound events fall
    // back only to a SOLE active account; account-agnostic ones (read/delivery
    // watermarks, reactions, edits, unsends) still apply, because they resolve
    // their target by message id and never needed an account.
    const { groups, dropped } = await groupEventsByInboundAccount(workspaceId, channel, events);
    for (const d of dropped) {
      this.logger.warn(
        `[${workspaceId}] dropped ${d.count} ${channel} event(s): ${d.reason}` +
          (d.externalAccountId ? ` (entry.id=${d.externalAccountId})` : ""),
      );
    }
    if (groups.length === 0) {
      return { ok: true, ingested: 0, dropped: "unknown_account" };
    }

    // NON-DM SOURCE GATE, per account.
    //
    // Direct messages are the core and pass untouched — they are why the channel
    // was connected. Everything else (comments today) is different work with
    // different reply rules and far higher volume, so it reaches the inbox only
    // where an admin has switched it on for THAT account.
    //
    // It has to be enforced here rather than at Meta: the `comments` webhook is
    // subscribed at the APP level and one app serves every workspace on the
    // shared connection, so unsubscribing there for one admin would blind all the
    // others. The dashboard decides whether Meta SENDS; this decides whether we
    // FILE. And it is here rather than in the parser because the parser is pure
    // and has no workspace — this is the first layer that knows whose account the
    // event arrived on. A group left with nothing after the filter is dropped, so
    // an opted-out workspace does no ingest work at all.
    let ingestable = groups;
    if (channelInboxSources(channel).length > 0) {
      const filtered: typeof groups = [];
      for (const group of groups) {
        if (!group.events.some((e) => nonDmSourceOf(e) !== null)) {
          filtered.push(group);
          continue;
        }
        const allowed = await getInstagramInboxSources(
          workspaceId,
          group.channelConnectionId,
        );
        const events = group.events.filter((e) => {
          const source = nonDmSourceOf(e);
          return source === null || allowed.has(source);
        });
        if (events.length > 0) filtered.push({ ...group, events });
      }
      ingestable = filtered;
      if (ingestable.length === 0) {
        return { ok: true, ingested: 0, dropped: "source_not_enabled" };
      }
    }

    // Kick off social media downloads (direct CDN URL → R2) concurrently with
    // ingest, which commits the rows as media-pending. Non-consuming catch so
    // an orphaned rejection can't float if ingest below fails and returns early;
    // completePendingMedia awaits the same promise on the success path.
    //
    // Only the INGESTABLE events, never the raw parse output: an unknown-account
    // group and an opted-out comment never get a Message row, so fetching their
    // attachments uploads blobs nothing will ever reference — orphans the blob
    // sweeper reclaims a day later.
    const ingestableEvents = ingestable.flatMap((g) => g.events);
    const downloadOutcomes = new Map<string, DownloadOutcome>();
    const downloadPromise = this.downloadSocialMedia(
      workspaceId,
      channel,
      ingestableEvents,
      downloadOutcomes,
    );
    downloadPromise.catch((err) =>
      this.logger.error(`[${workspaceId}] ${channel} media download failed`, err),
    );

    // Sequential per group, same fail-soft contract as WhatsApp.
    let ingested = 0;
    for (const group of ingestable) {
      if (await this.ingestGroup(workspaceId, channel, group)) {
        ingested += group.events.length;
      }
    }
    if (ingested === 0) return { ok: true, ingested: 0, dropped: "ingest_failed" };

    // Detached: give brand-new social contacts a real display name (the webhook
    // carries none, so ingest named them by their opaque id). Never blocks the
    // 200; fail-soft. Non-consuming catch so the fire-and-forget can't float.
    //
    // Per GROUP, because a PSID/IGSID only resolves against the Page/IG account
    // that issued it — enriching a second Page's senders with the first Page's
    // token returns nothing (or the wrong person).
    for (const group of ingestable) {
      if (!group.channelConnectionId) continue;
      const senderIds = group.events.flatMap((e) =>
        e.kind === "message" && e.externalContactId ? [e.externalContactId] : [],
      );
      if (senderIds.length === 0) continue;
      void enrichSocialContactNames(
        workspaceId,
        channel,
        senderIds,
        group.channelConnectionId,
      ).catch((err) =>
        this.logger.error(`[${workspaceId}] ${channel} name enrichment failed`, err),
      );
    }

    // Background: await the media downloads, then patch the rows + emit
    // message:media:ready (or collapse the shimmer to a labeled bubble on
    // failure). Tracked in inFlightMedia so onModuleDestroy drains it on
    // shutdown rather than abandoning a half-written patch.
    const completion = this.completePendingMedia(
      workspaceId,
      ingestableEvents,
      downloadPromise,
      downloadOutcomes,
      channel,
    ).catch((err) =>
      this.logger.error(`[${workspaceId}] ${channel} media completion failed`, err),
    );
    this.inFlightMedia.add(completion);
    void completion.finally(() => this.inFlightMedia.delete(completion));

    return {
      ok: true,
      ingested,
      ...(dropped.length > 0 ? { dropped: "partial_unknown_account" } : {}),
    };
  }

  /**
   * Wait for the in-flight download to finish, then bring every still-
   * pending row up to date — set its media columns + emit
   * `message:media:ready`, or clear the placeholder if the download failed.
   * Only fires when the in-band budget expired; the happy-path race-winner
   * case never calls this.
   */
  private async completePendingMedia(
    workspaceId: string,
    events: NormalizedEvent[],
    downloadPromise: Promise<void>,
    outcomes: Map<string, DownloadOutcome>,
    channel: Channel = "whatsapp",
  ): Promise<void> {
    await downloadPromise;
    const candidates = events
      .filter(
        (e): e is Extract<NormalizedEvent, { kind: "message" | "echo" }> =>
          // Include Coexistence echoes: a photo the owner sent from the phone
          // app needs the same fetch → patch → media_ready flow as inbound media.
          e.kind === "message" || e.kind === "echo",
      )
      .filter((evt) => evt.media || this.hadMedia(evt));
    if (candidates.length === 0) return;

    // Bulk-load every candidate row in a single round-trip instead of one
    // findFirst per event — at a 4-image batch this saves ~3 DB RTTs and
    // turns the per-event loop into pure CPU + a single later updateMany.
    const externalIds = candidates.map((e) => e.externalId);
    const rows = await this.db.message.findMany({
      where: { workspaceId, channel, externalId: { in: externalIds } },
      select: {
        id: true,
        externalId: true,
        conversationId: true,
        mediaUrl: true,
        mediaKind: true,
        body: true,
      },
    });
    const rowByExtId = new Map(rows.map((r) => [r.externalId, r]));

    for (const evt of candidates) {
      const row = rowByExtId.get(evt.externalId);
      if (!row) continue;
      const outcome = outcomes.get(evt.externalId);

      if (outcome?.ok && evt.media) {
        // Download succeeded after the race lost. Patch + emit. CAS on
        // BOTH `mediaUrl: null` AND `mediaKind: { not: null }`:
        //   - `mediaUrl: null` keeps the duplicate-completion path a no-op
        //     (e.g. the race winner already wrote, or a Meta retry's clone
        //     finished first).
        //   - `mediaKind: { not: null }` defends against the sweeper having
        //     already cleared this row's pending-media state. Without it,
        //     a slow video download (≥ 2min wall clock) that lands AFTER
        //     the inbound-media sweeper has nulled mediaKind would resurrect
        //     mediaUrl + mediaKey on a row whose mediaKind is null — the
        //     bubble renders with no kind metadata.
        if (row.mediaUrl || !row.mediaKind) continue;
        // Prefer a duration probed from the bytes (inbound audio has none on the
        // webhook) over whatever the event carried.
        const durationMs = outcome.durationMs ?? evt.media.durationMs ?? null;
        const updated = await this.db.message.updateMany({
          where: { id: row.id, mediaUrl: null, mediaKind: { not: null } },
          data: {
            mediaKey: outcome.storageKey,
            mediaUrl: outcome.storageUrl,
            mediaSizeBytes: outcome.sizeBytes,
            mediaMimeType: outcome.mimeType,
            ...(durationMs != null ? { mediaDurationMs: durationMs } : {}),
            ...(outcome.thumbnailStorageKey && outcome.thumbnailStorageUrl
              ? {
                  mediaThumbnailKey: outcome.thumbnailStorageKey,
                  mediaThumbnailUrl: outcome.thumbnailStorageUrl,
                }
              : {}),
          },
        });
        if (updated.count === 0) continue;
        await publish({
          type: "message.media_ready",
          workspaceId,
          conversationId: row.conversationId,
          messageId: row.id,
          media: {
            kind: evt.media.kind,
            url: `/api/media/${row.id}`,
            mimeType: outcome.mimeType,
            sizeBytes: outcome.sizeBytes,
            ...(evt.body ? { caption: evt.body } : {}),
            ...(evt.media.filename ? { filename: evt.media.filename } : {}),
            ...(durationMs != null ? { durationMs } : {}),
            // Carry the WhatsApp push-to-talk flag so the just-arrived voice note
            // renders with the mic glyph + waveform LIVE — applyMessageMediaReady
            // replaces `media` wholesale, so a voice-less frame would otherwise
            // overwrite the placeholder's voice:true and the bubble would read as
            // a generic audio file until the next SSR/refetch.
            ...(evt.media.voice ? { voice: true } : {}),
            ...(outcome.thumbnailStorageUrl
              ? { thumbnailUrl: `/api/media/${row.id}/thumb` }
              : {}),
          },
        });
      } else if (outcome && !outcome.ok && outcome.retriable) {
        // Transient download failure — PARK the row in its media-pending state
        // (mediaKind set, mediaUrl null) instead of clearing. The inbound-media
        // sweeper re-attempts the download from the Meta media id in rawPayload
        // over its 24h horizon before any final text-only downgrade. Leaving
        // the bubble as a shimmer is the correct signal: the media is still
        // being fetched, not lost.
        continue;
      } else if (
        (outcome && !outcome.ok && !outcome.retriable) ||
        (!outcome && row.mediaKind && !row.mediaUrl)
      ) {
        // Permanent download failure (over cap / no send config) OR no outcome
        // ever arrived and the row is stuck in media-pending state. Strip the
        // media columns + emit empty `message:media:ready` so the shimmer
        // collapses to a text-only bubble (caption preserved). CAS on
        // `mediaKind: { not: null }` so a duplicate completion path
        // (concurrent Meta retry that also failed) becomes a no-op instead
        // of re-emitting the clear event to every connected agent.
        if (!row.mediaKind || row.mediaUrl) continue;
        // When the row would otherwise collapse to an EMPTY bubble (no caption),
        // stamp a kind label ("🌟 Sticker" / "🎤 Voice message" / …) so a media we
        // couldn't download reads as what it was, not a bare "Attachment
        // unavailable". Only when the body is empty — a caption is preserved.
        const fallbackBody =
          row.body && row.body.length > 0
            ? undefined
            : mediaPreviewLabel(row.mediaKind as MediaKind);
        const cleared = await this.db.message.updateMany({
          where: { id: row.id, mediaKind: { not: null }, mediaUrl: null },
          data: {
            mediaKind: null,
            mediaMimeType: null,
            mediaCaption: null,
            mediaFilename: null,
            mediaDurationMs: null,
            mediaKey: null,
            mediaUrl: null,
            mediaSizeBytes: null,
            ...(fallbackBody ? { body: fallbackBody } : {}),
          },
        });
        if (cleared.count === 0) continue;
        await publish({
          type: "message.media_ready",
          workspaceId,
          conversationId: row.conversationId,
          messageId: row.id,
          // No media (download failed) — the reducer strips the media block. The
          // fallback label lands on the row via `body` above; it shows on the next
          // fetch/reload (the media_ready frame carries no body).
        });
      }
    }
  }

  /**
   * Return true iff the payload's `entry[*].changes[*].value.metadata
   * .phone_number_id` does NOT match the team's stored metaPhoneNumberId.
   *
   * Returns false (= "match, proceed") when:
   *   - The team has no `metaPhoneNumberId` configured (fresh onboarding).
   *   - The payload omits metadata (some Meta event types, e.g. some
   *     account-update webhooks, don't carry it — we can't filter and
   *     leave them as the appSecret-only check).
   *   - Every change's phone_number_id matches the team's.
   *
   * Only iterates the shape we care about — a malformed payload (no entry
   * array) returns false rather than crashing the request.
   */
  /**
   * Did the parser originally attach media to this event? Used to tell
   * apart "never had media" (nothing to patch) from "had media but the
   * download path deleted it on failure" (need to clear the placeholder).
   */
  private hadMedia(
    evt: Extract<NormalizedEvent, { kind: "message" | "echo" }>,
  ): boolean {
    // `rawPayload` is Meta's verbatim webhook body. `messages[].type` is one of
    // "text" | "image" | "video" | "audio" | "document" | "sticker" when this
    // event came from Meta. Any non-text type means the parser originally
    // produced an evt.media that may have since been deleted.
    //
    // Search EVERY entry/change, not `entry[0].changes[0]`: Meta batches changes
    // for several accounts into one POST, so this event's own message can sit in
    // any entry — reading only the first silently reported "no media" for
    // everything after it, collapsing those bubbles to a bare label.
    const payload = evt.rawPayload as {
      entry?: { changes?: { value?: { messages?: { id?: string; type?: string }[] } }[] }[];
    };
    for (const entry of payload.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const found = change?.value?.messages?.find((x) => x.id === evt.externalId);
        if (found) return found.type !== "text";
      }
    }
    return false;
  }

  /**
   * Download inbound SOCIAL media (Messenger / Instagram). Unlike WhatsApp —
   * which fetches by media-id using the send config — social attachments arrive
   * as a direct, expiring CDN URL (`evt.media.sourceUrl`), so we GET the URL,
   * size-cap it, and stream it to R2. Same outcomes-Map contract as
   * `downloadInboundMedia` (never mutates `evt.media`; records `{ok:false}` on
   * failure so the row commits as a labeled bubble, not a stuck shimmer). No
   * WhatsApp send-config needed, so a social-only team downloads media fine.
   */
  private async downloadSocialMedia(
    workspaceId: string,
    channel: Channel,
    events: NormalizedEvent[],
    outcomes: Map<string, DownloadOutcome>,
  ): Promise<void> {
    const mediaEvents = events.filter(
      (e): e is Extract<NormalizedEvent, { kind: "message" | "echo" }> =>
        (e.kind === "message" || e.kind === "echo") &&
        !!e.media?.sourceUrl &&
        !e.media.storageKey,
    );
    if (mediaEvents.length === 0) return;

    // Idempotency: a Meta retry of an already-ingested batch shouldn't
    // re-download. An existing row with a mediaUrl → record success + skip.
    const externalIds = mediaEvents.map((e) => e.externalId);
    const existing = await this.db.message.findMany({
      where: { workspaceId, channel, externalId: { in: externalIds } },
      select: {
        externalId: true,
        mediaKey: true,
        mediaUrl: true,
        mediaSizeBytes: true,
        mediaMimeType: true,
      },
    });
    const existingByExtId = new Map(existing.map((r) => [r.externalId, r]));
    const todo = mediaEvents.filter((evt) => {
      const row = existingByExtId.get(evt.externalId);
      if (row?.mediaUrl && evt.media) {
        outcomes.set(evt.externalId, {
          ok: true,
          storageKey: row.mediaKey ?? "",
          storageUrl: row.mediaUrl,
          sizeBytes: row.mediaSizeBytes ?? 0,
          mimeType: row.mediaMimeType ?? evt.media.mimeType,
        });
        return false;
      }
      return true;
    });
    if (todo.length === 0) return;

    const team = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    });

    await runWithConcurrency(todo, 4, async (evt) => {
      const media = evt.media;
      if (!media?.sourceUrl) return;
      const mediaKind = media.kind;
      // A native-inbox echo (business sent it from Meta's app) is OUTBOUND and
      // carries no contactName; an inbound message is the inverse.
      const isEcho = evt.kind === "echo";
      const blobDirection: "in" | "out" = isEcho ? "out" : "in";
      const blobContactName =
        evt.kind === "message" ? evt.contactName ?? undefined : undefined;
      // Channel-aware cap — Messenger/Instagram deliver larger media than
      // WhatsApp's caps allow, so use the per-channel policy here too.
      const cap = mediaPolicyForChannel(channel).caps[mediaKind];
      try {
        // Same process-wide download slot as the WhatsApp path — a parallel
        // burst of social attachments (25MB each) buffers just as much RAM.
        const fetched = await withMediaDownloadSlot(() =>
          retry(() => fetchUrlBytes(media.sourceUrl!, cap), {
            attempts: 3,
            baseMs: 250,
          }),
        );
        if (fetched.bytes.length > cap) {
          this.logger.warn(
            `[${workspaceId}] dropping social ${mediaKind} over cap (${fetched.bytes.length} > ${cap})`,
          );
          outcomes.set(evt.externalId, { ok: false, retriable: false });
          return;
        }
        // Meta's social CDN mislabels voice notes (m4a/aac = MP4 container) as
        // `video/mp4`; reconcile against the trusted kind so audio isn't dropped.
        const storeMime = reconcileInboundMediaMime(mediaKind, fetched.mimeType, fetched.bytes);
        const saved = await retry(
          () =>
            blobStorage.upload({
              bytes: fetched.bytes,
              mimeType: storeMime,
              kind: mediaKind,
              context: {
                workspaceId,
                teamSlug: team?.name,
                direction: blobDirection,
                // Social has no phone; use the opaque id for the dashboard name.
                contactPhone: evt.externalContactId,
                contactName: blobContactName,
                externalId: evt.externalId,
                originalFilename: media.filename ?? null,
              },
            }),
          { attempts: 3, baseMs: 250 },
        );

        let thumbnailStorageKey: string | undefined;
        let thumbnailStorageUrl: string | undefined;
        if (mediaKind === "video" || mediaKind === "image") {
          try {
            // Video → poster frame; image → downscaled thumbnail. Both are
            // uploaded + served the same way (the bubble prefers the thumb, taps
            // through to the original).
            const poster =
              mediaKind === "video"
                ? await extractVideoPosterFrame(fetched.bytes)
                : await extractImageThumbnail(fetched.bytes);
            if (poster && poster.length > 0) {
              const thumb = await retry(
                () =>
                  blobStorage.upload({
                    bytes: poster,
                    mimeType: "image/jpeg",
                    kind: "image",
                    context: {
                      workspaceId,
                      teamSlug: team?.name,
                      direction: blobDirection,
                      contactPhone: evt.externalContactId,
                      contactName: blobContactName,
                      externalId: `${evt.externalId}_thumb`,
                      originalFilename: null,
                    },
                  }),
                { attempts: 2, baseMs: 250 },
              );
              thumbnailStorageKey = thumb.key;
              thumbnailStorageUrl = thumb.url;
            }
          } catch (err) {
            this.logger.warn(
              `[${workspaceId}] social video poster failed for ${evt.externalId}: ${err instanceof Error ? err.message : err}`,
            );
          }
        }

        let durationMs: number | undefined;
        if (mediaKind === "audio") {
          durationMs = (await probeMediaDurationMs(fetched.bytes)) ?? undefined;
        }

        outcomes.set(evt.externalId, {
          ok: true,
          storageKey: saved.key,
          storageUrl: saved.url,
          sizeBytes: saved.sizeBytes,
          mimeType: storeMime,
          ...(thumbnailStorageKey && thumbnailStorageUrl
            ? { thumbnailStorageKey, thumbnailStorageUrl }
            : {}),
          ...(durationMs != null ? { durationMs } : {}),
        });
      } catch (err) {
        this.logger.warn(
          `[${workspaceId}] social media download failed for ${evt.externalId}: ${err instanceof Error ? err.message : err}`,
        );
        // The inbound-media sweeper re-fetches by WhatsApp media-id, which social
        // has none of (and the CDN URL expires), so mark non-retriable — the row
        // commits as a labeled bubble rather than a shimmer the sweeper can't fix.
        outcomes.set(evt.externalId, { ok: false, retriable: false });
      }
    });
  }

  /**
   * Download every inbound media binary and write the outcome to the shared
   * `outcomes` Map keyed by `evt.externalId`. CRITICALLY: this does NOT
   * mutate `evt.media` — see the DownloadOutcome doc above and the race
   * fence in `handlePost` for why. `ingestEvents` reads `evt.media`
   * synchronously inside its transaction; concurrent in-place mutation
   * here used to interleave with that read, producing torn rows (storageKey
   * set but storageUrl null, etc.).
   *
   * On any failure (no send config, size cap, fetch error, upload error)
   * we set `outcomes.set(id, { ok: false })` so the row commits text-only
   * with the caption — visible failure, not a stuck shimmer.
   */
  private async downloadInboundMedia(
    workspaceId: string,
    events: NormalizedEvent[],
    outcomes: Map<string, DownloadOutcome>,
    /**
     * The account this batch arrived on. REQUIRED in a multi-account
     * workspace: a Meta media id is scoped to the account that received it, so
     * fetching it with a sibling number's token is wrong on its face — and
     * since the account-unresolved guard landed, omitting it makes
     * `getMetaSendConfig` REFUSE, which failed every media event
     * non-retriably and destroyed the binary permanently.
     */
    accountId: string | undefined,
  ): Promise<void> {
    const mediaEvents = events.filter(
      (e): e is Extract<NormalizedEvent, { kind: "message" | "echo" }> =>
        (e.kind === "message" || e.kind === "echo") &&
        !!e.media &&
        !e.media.storageKey,
    );
    if (mediaEvents.length === 0) return;

    // Idempotency: a Meta retry of an already-ingested batch shouldn't
    // re-download and re-upload. If the row already exists with a mediaUrl
    // we record it as a successful outcome so ingest skips the create via
    // P2002 and we save the Meta fetch + blob upload entirely.
    const externalIds = mediaEvents.map((e) => e.externalId);
    const existing = await this.db.message.findMany({
      where: { workspaceId, channel: "whatsapp", externalId: { in: externalIds } },
      select: {
        externalId: true,
        mediaKey: true,
        mediaUrl: true,
        mediaSizeBytes: true,
        mediaMimeType: true,
      },
    });
    const existingByExtId = new Map(existing.map((r) => [r.externalId, r]));
    const todo = mediaEvents.filter((evt) => {
      const row = existingByExtId.get(evt.externalId);
      if (row?.mediaUrl && evt.media) {
        outcomes.set(evt.externalId, {
          ok: true,
          storageKey: row.mediaKey ?? "",
          storageUrl: row.mediaUrl,
          sizeBytes: row.mediaSizeBytes ?? 0,
          mimeType: row.mediaMimeType ?? evt.media.mimeType,
        });
        return false;
      }
      return true;
    });
    if (todo.length === 0) return;

    let sendConfig;
    try {
      sendConfig = await getMetaSendConfig(workspaceId, accountId);
    } catch (err) {
      this.logger.warn(`[${workspaceId}] cannot download media — send config missing`, err);
      // No way to fetch any of them — record failure so each row is created
      // as text-only with the caption preserved. Non-retriable: a missing send
      // config is a structural/config issue, not a transient blip — parking
      // these would just leave a shimmer the sweeper can never resolve either.
      for (const evt of todo) outcomes.set(evt.externalId, { ok: false, retriable: false });
      return;
    }

    const team = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    });

    // 4 in-flight covers network latency without piling RAM (each fetch
    // buffers the binary). For a 4-image batch this stays under ~3s end
    // to end even on a cold Meta connection — well inside Meta's retry
    // window.
    await runWithConcurrency(todo, 4, async (evt) => {
      if (!evt.media) return;
      const mediaKind = evt.media.kind;
      // Blob-storage context differs by source: inbound customer media vs. a
      // Coexistence echo (a photo the owner sent from the phone). Echoes carry
      // no contactName (the `to` is just a number), so read it only when present.
      const isEcho = evt.kind === "echo";
      const blobDirection: "in" | "out" = isEcho ? "out" : "in";
      const blobContactName = "contactName" in evt ? evt.contactName ?? undefined : undefined;
      try {
        // Bounded retry on transient fetch/upload errors. Meta's media
        // download endpoint occasionally returns a 500 / connection reset
        // even though the binary is fine; without retry, a single blip
        // permanently strands the media (the row commits text-only and
        // there's no second chance). Three attempts × ~250-1000ms back-off
        // keeps total wall-time well inside Meta's webhook retry window.
        const cap = MEDIA_SIZE_CAPS[mediaKind];
        // minor#3: hand the per-kind cap to fetchMedia so it can reject via
        // Content-Length BEFORE buffering the binary into heap (RAM guard for a
        // 4-wide batch of large docs). The post-buffer check below stays as the
        // authoritative cap for the case where the CDN omits/understates the
        // header.
        // Hold a process-wide download slot for the fetch: the per-batch
        // runWithConcurrency(4) only bounds THIS webhook, but Meta fans
        // deliveries out in parallel across all tenants, so a redelivery burst
        // can put dozens of full binary Buffers in flight at once. The slot caps
        // the aggregate; a wait-timeout throws into the catch below → retriable
        // outcome → sweeper re-attempts. See withMediaDownloadSlot.
        const fetched = await withMediaDownloadSlot(() =>
          retry(
            () =>
              getMetaProvider().fetchMedia!(evt.media!.externalMediaId, sendConfig, cap),
            { attempts: 3, baseMs: 250 },
          ),
        );
        if (fetched.bytes.length > cap) {
          this.logger.warn(
            `[${workspaceId}] dropping ${mediaKind} over cap (${fetched.bytes.length} > ${cap})`,
          );
          // Deterministic: re-downloading yields the same over-cap bytes.
          outcomes.set(evt.externalId, { ok: false, retriable: false });
          return;
        }
        // Reconcile a CDN-mislabeled audio/video Content-Type against the trusted
        // kind (same voice-note guard as the social path — harmless here since
        // WhatsApp's media-node mime is usually accurate).
        const storeMime = reconcileInboundMediaMime(mediaKind, fetched.mimeType, fetched.bytes);
        const saved = await retry(
          () =>
            blobStorage.upload({
              bytes: fetched.bytes,
              mimeType: storeMime,
              kind: mediaKind,
              context: {
                workspaceId,
                teamSlug: team?.name,
                direction: blobDirection,
                contactPhone: evt.contactPhone,
                contactName: blobContactName,
                externalId: evt.externalId,
                originalFilename: evt.media!.filename ?? null,
              },
            }),
          { attempts: 3, baseMs: 250 },
        );

        let thumbnailStorageKey: string | undefined;
        let thumbnailStorageUrl: string | undefined;
        // Video-only: generate + upload a poster frame so the bubble doesn't
        // render as a black rectangle until the user clicks play. Best-effort;
        // an ffmpeg failure or corrupt video leaves thumbnail* fields null
        // and the VideoBlock falls back to bg-black (same end-state as
        // before M8 landed). Bounded at ~10s of ffmpeg wall-clock.
        if (mediaKind === "video" || mediaKind === "image") {
          try {
            // Video → poster frame; image → downscaled thumbnail. Both are
            // uploaded + served the same way (the bubble prefers the thumb, taps
            // through to the original).
            const poster =
              mediaKind === "video"
                ? await extractVideoPosterFrame(fetched.bytes)
                : await extractImageThumbnail(fetched.bytes);
            if (poster && poster.length > 0) {
              const thumb = await retry(
                () =>
                  blobStorage.upload({
                    bytes: poster,
                    mimeType: "image/jpeg",
                    kind: "image",
                    context: {
                      workspaceId,
                      teamSlug: team?.name,
                      direction: blobDirection,
                      contactPhone: evt.contactPhone,
                      contactName: blobContactName,
                      // Suffix the wamid so the dashboard filename is
                      // distinct from the original video's blob.
                      externalId: `${evt.externalId}_thumb`,
                      originalFilename: null,
                    },
                  }),
                { attempts: 2, baseMs: 250 },
              );
              thumbnailStorageKey = thumb.key;
              thumbnailStorageUrl = thumb.url;
            }
          } catch (err) {
            this.logger.warn(
              `[${workspaceId}] video poster generation failed for ${evt.externalId}: ${err instanceof Error ? err.message : err}`,
            );
            // Swallow — the video itself is fine; the bubble just won't
            // have a poster. Strictly better than failing the whole ingest.
          }
        }

        // Audio/voice: the WhatsApp webhook carries no duration, so probe it
        // from the bytes (best-effort) — real WhatsApp shows the length up front.
        let durationMs: number | undefined;
        if (mediaKind === "audio") {
          durationMs = (await probeMediaDurationMs(fetched.bytes)) ?? undefined;
        }

        // Commit the successful outcome AFTER every async step is done.
        // Single atomic Map.set per event — no torn state possible because
        // the caller reads the value, not individual fields.
        outcomes.set(evt.externalId, {
          ok: true,
          storageKey: saved.key,
          storageUrl: saved.url,
          sizeBytes: saved.sizeBytes,
          mimeType: storeMime,
          ...(thumbnailStorageKey && thumbnailStorageUrl
            ? { thumbnailStorageKey, thumbnailStorageUrl }
            : {}),
          ...(durationMs != null ? { durationMs } : {}),
        });
      } catch (err) {
        // minor#3: an over-cap file (rejected pre-buffer via Content-Length) is
        // a DETERMINISTIC failure — re-downloading yields the same over-cap
        // bytes — so drop it non-retriably, exactly like the post-buffer cap
        // check above. Parking it for the sweeper would loop forever.
        if (err instanceof MediaTooLargeError) {
          this.logger.warn(
            `[${workspaceId}] dropping ${mediaKind} over cap before download (${err.declaredBytes} > ${err.maxBytes})`,
          );
          outcomes.set(evt.externalId, { ok: false, retriable: false });
          return;
        }
        this.logger.error(
          `[${workspaceId}] media download failed for ${evt.externalId} after retries`,
          err,
        );
        // Transient (Meta-CDN / blob blip survived the in-request retry) —
        // park the row so the inbound-media sweeper re-attempts over its
        // longer horizon instead of losing the media permanently. Meta retains
        // the binary ~30 days, so the media id in rawPayload stays fetchable.
        outcomes.set(evt.externalId, { ok: false, retriable: true });
      }
    });
  }
}


/**
 * Tiny bounded-retry helper. Used for transient Meta / R2 errors
 * inside the webhook handler — long enough to ride out a single blip,
 * short enough to stay inside Meta's ~10s webhook retry window.
 */
async function retry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; baseMs: number },
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === opts.attempts - 1) break;
      const jitter = Math.random() * opts.baseMs * 0.25;
      await new Promise((r) => setTimeout(r, opts.baseMs * 2 ** i + jitter));
    }
  }
  throw lastErr;
}
