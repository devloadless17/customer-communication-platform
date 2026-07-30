import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { invalidateProviderConfig } from "@/lib/providers/config";
import { decryptSecret } from "@/lib/crypto/envelope";
import { releaseWabaSubscription } from "@/lib/providers/meta-waba-subscription";
import { releasePageSubscription } from "@/lib/providers/meta-page-subscription";
import {
  gcOrphanWhatsappPortfolios,
  portfolioTemplateLimit,
} from "@/lib/providers/meta-health";
import { invalidateMessengerConfig } from "@/lib/providers/messenger-config";
import { invalidateInstagramConfig } from "@/lib/providers/instagram-config";
import {
  channelAccountDisplayName,
  channelAccountProviderName,
} from "@/lib/channel-accounts/display";
import { EventBus } from "../../events/event-bus.module";
import type { Channel } from "@ccp/shared/types";
import { classifyMetaAppBinding, type MetaAppBinding } from "@/lib/providers/meta-app-binding";

import { DbService } from "../../db/db.service";

/** Channels whose accounts are ChannelConnection rows (webchat uses WebchatWidget). */
export type AccountChannel = "whatsapp" | "messenger" | "instagram";

/** Same default the channel services use; Graph version is a non-secret env. */
const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";

export interface ChannelAccountDto {
  id: string;
  channel: Channel;
  /** The provider's own id — phone-number id / Page id / IG account id. */
  externalAccountId: string;
  label: string | null;
  isDefault: boolean;
  isActive: boolean;
  needsReconnect: boolean;
  /** WhatsApp only. */
  displayPhoneNumber: string | null;
  wabaId: string | null;
  /**
   * WhatsApp only: the display name's review status at Meta (raw vocabulary:
   * APPROVED | DECLINED | EXPIRED | PENDING_REVIEW | NONE …). Readiness state,
   * not cosmetics — NONE/EXPIRED voids the number's certificate, which blocks
   * Cloud API (re)registration.
   */
  nameStatus: string | null;
  createdAt: string;
  /**
   * WHICH META APP this account is on — the relationship nothing in the UI used
   * to state.
   *
   * Meta's model is one app ↔ many accounts, so a workspace keeps one shared app
   * whose credentials are copied onto each account as it connects; an account may
   * instead carry a different app's credentials. Without this an admin could see
   * *how many* accounts they had but not which app any of them ran on — so
   * "if I add another app, which accounts move?" was unanswerable in-product, and
   * a shared-secret rotation silently applied to some accounts and not others.
   *
   * Admin-only, and never a secret: `appId` is public (it ships in Meta's JS SDK),
   * while the secret and token stay server-side. Deliberately NOT on
   * `ChannelAccountDirectoryEntry`, which every member can read.
   */
  appBinding: MetaAppBinding;
  /** The Meta app id, when one is known — the account's own, else the shared app's. */
  appId: string | null;
  /**
   * Per-ACCOUNT messaging health (WhatsApp only; null elsewhere).
   *
   * This has to be per-account, not one figure for the channel. Quality and
   * throughput are per NUMBER — two numbers in one workspace can sit at GREEN
   * and RED simultaneously — while the tier and 24h cap are per PORTFOLIO and
   * therefore SHARED by every number under it. Showing the default account's
   * health as if it described the channel is not a rounding error: it tells an
   * operator their sending is healthy while a second number is being throttled.
   */
  health: ChannelAccountHealth | null;
}

/** What Meta currently allows one specific WhatsApp number to do. */
export interface ChannelAccountHealth {
  /** GREEN | YELLOW | RED — per number. */
  qualityRating: string | null;
  /** STANDARD (~80 msg/s) | HIGH (~1,000 msg/s) — per number. */
  throughputLevel: string | null;
  /** When Meta last told us, or we last asked. */
  updatedAt: string | null;
  /**
   * The business portfolio this number sits under. Null until a token with
   * `business_management` has resolved it. SHARED — every number carrying the
   * same `externalId` here draws on one 24h budget and one template limit.
   */
  portfolio: {
    externalId: string | null;
    /** Raw tier, e.g. "TIER_10K". */
    messagingTier: string | null;
    /** Derived 24h unique-recipient cap; null = unlimited or unknown. */
    messagingDailyCap: number | null;
    /** Meta's `verification_status` — drives the template limit. */
    verificationStatus: string | null;
    /** Templates per WABA under this portfolio (250, or up to 6,000 verified). */
    templateLimit: number;
    /** How many of this workspace's accounts share this portfolio. */
    accountCount: number;
  } | null;
}

/**
 * One connected account as every MEMBER may see it: enough to attribute a
 * conversation to a number/Page/handle, and nothing else. No credentials, no
 * verify token, no WABA or portfolio id.
 */
export interface ChannelAccountDirectoryEntry {
  id: string;
  channel: Channel;
  /** Display name — admin label, else the provider's own name, else the id. */
  name: string;
  /** The provider's human identifier, when known (+1 555…, a Page name, @handle). */
  providerName: string | null;
  isDefault: boolean;
  isActive: boolean;
  /** Expired token (Graph 190): replies on this account's threads will fail
   *  until an admin reconnects. Drives the inbox's amber trust pill. */
  needsReconnect: boolean;
}

@Injectable()
export class ChannelAccountsService {
  private readonly logger = new Logger(ChannelAccountsService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  /**
   * Tell every tab the account catalog moved.
   *
   * The directory is SSR-seeded once in the APP layout and never refetched, so
   * without this a renamed number — or a new default — stays stale on every
   * other open tab until someone hard-navigates. The connect/disconnect paths
   * in the per-channel services already publish this; the per-account mutators
   * never did, which only stopped mattering the moment the directory went
   * app-wide. Existing event, existing fanout rule, no new plumbing.
   */
  private async announce(workspaceId: string): Promise<void> {
    await this.bus.publish({ type: "team.catalog_changed", workspaceId, scope: "channels" });
  }

  /**
   * Decrypt a stored app secret for COMPARISON only.
   *
   * Fail-soft: a secret we can't decrypt (rotated `ENCRYPTION_KEY`, corrupt
   * ciphertext) must not blank the whole accounts page — the account still exists
   * and the admin still needs to see it. It classifies as `unset`, which reads as
   * "we can't tell", not as a false "shared".
   */
  private tryDecryptAppSecret(cipher: string | null): string | null {
    if (cipher == null) return null;
    try {
      return decryptSecret(cipher);
    } catch (err) {
      this.logger.warn(
        `could not decrypt an account app secret for app-binding classification: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Every account a workspace has connected on `channel`, default first. */
  async list(workspaceId: string, channel: AccountChannel): Promise<ChannelAccountDto[]> {
    // The workspace's shared Meta app, to classify each account against it. One
    // read for the whole list, not one per account.
    const sharedApp = await this.db.metaConnection.findUnique({
      where: { workspaceId },
      select: { config: true, secrets: true },
    });
    const sharedAppId =
      (sharedApp?.config as { appId?: string } | null)?.appId ?? null;
    const sharedAppSecret = this.tryDecryptAppSecret(
      (sharedApp?.secrets as { appSecret?: string } | null)?.appSecret ?? null,
    );
    const rows = await this.db.channelConnection.findMany({
      where: { workspaceId, channel },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        channel: true,
        externalAccountId: true,
        label: true,
        isDefault: true,
        isActive: true,
        needsReconnect: true,
        // Meta's own WABA id (never our internal cuid), plus the portfolio the
        // 24h budget is shared over — both reached through the WABA, which is
        // where Meta records portfolio ownership.
        wabaAccount: {
          select: {
            externalWabaId: true,
            portfolio: {
              select: {
                externalPortfolioId: true,
                messagingTier: true,
                messagingDailyCap: true,
                verificationStatus: true,
                maxPhoneNumbers: true,
                source: true,
                wabaAccounts: { select: { _count: { select: { connections: true } } } },
              },
            },
          },
        },
        nameStatus: true,
        config: true,
        // Only to CLASSIFY the account's app against the shared one — compared
        // in-process and never returned. See `classifyMetaAppBinding`.
        secrets: true,
        createdAt: true,
        qualityRating: true,
        throughputLevel: true,
        messagingHealthUpdatedAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      externalAccountId: r.externalAccountId,
      label: r.label,
      isDefault: r.isDefault,
      isActive: r.isActive,
      needsReconnect: r.needsReconnect,
      displayPhoneNumber:
        (r.config as { displayPhoneNumber?: string } | null)?.displayPhoneNumber ?? null,
      wabaId: r.wabaAccount?.externalWabaId ?? null,
      nameStatus: r.nameStatus,
      createdAt: r.createdAt.toISOString(),
      appBinding: classifyMetaAppBinding(
        this.tryDecryptAppSecret((r.secrets as { appSecret?: string } | null)?.appSecret ?? null),
        sharedAppSecret,
      ),
      // The account's own app id when it has one, else the shared app's — matching
      // how the credentials themselves resolve.
      appId: (r.config as { appId?: string } | null)?.appId ?? sharedAppId,
      // Only WhatsApp carries messaging health; the social channels have no
      // equivalent from Meta, so `null` means "not applicable", not "unknown".
      health:
        channel !== "whatsapp"
          ? null
          : {
              qualityRating: r.qualityRating,
              throughputLevel: r.throughputLevel,
              updatedAt: r.messagingHealthUpdatedAt?.toISOString() ?? null,
              portfolio: r.wabaAccount?.portfolio
                ? {
                    externalId: r.wabaAccount.portfolio.externalPortfolioId,
                    messagingTier: r.wabaAccount.portfolio.messagingTier,
                    messagingDailyCap: r.wabaAccount.portfolio.messagingDailyCap,
                    verificationStatus: r.wabaAccount.portfolio.verificationStatus,
                    templateLimit: portfolioTemplateLimit(
                      r.wabaAccount.portfolio.verificationStatus,
                    ),
                    // Numbers sharing this budget across ALL of the portfolio's
                    // WABAs — what makes "7,850 of 10,000 left" legible when the
                    // budget isn't only this number's.
                    accountCount: r.wabaAccount.portfolio.wabaAccounts.reduce(
                      (n, w) => n + w._count.connections,
                      0,
                    ),
                    // Meta's registered-number cap for the portfolio, and whether we
                    // have a REAL portfolio yet: `local` means "not linked — grant
                    // business_management and re-save", which the panel can say
                    // instead of showing a null external id that reads as a bug.
                    maxPhoneNumbers: r.wabaAccount.portfolio.maxPhoneNumbers,
                    source: r.wabaAccount.portfolio.source,
                  }
                : null,
            },
    }));
  }

  /**
   * What disconnecting this account would actually cost, so the confirm dialog
   * can state it instead of warning in the abstract.
   *
   * "Existing conversations are kept but can't be replied to" is true and
   * useless — an admin cannot weigh it without knowing whether that is 2 threads
   * or 2,000, and whether any are still open. Counting first turns an
   * irreversible action into an informed one.
   */
  async removalImpact(
    workspaceId: string,
    channel: AccountChannel,
    id: string,
  ): Promise<{ conversations: number; openConversations: number; scheduledBroadcasts: number }> {
    const target = await this.db.channelConnection.findFirst({
      where: { id, workspaceId, channel },
      select: { id: true },
    });
    if (!target) throw new NotFoundException({ error: "account_not_found" });

    const [conversations, openConversations, scheduledBroadcasts] = await Promise.all([
      this.db.conversation.count({ where: { workspaceId, channelConnectionId: id } }),
      this.db.conversation.count({
        where: { workspaceId, channelConnectionId: id, status: { not: "closed" } },
      }),
      // A queued campaign bound to this account. `Broadcast.channelConnectionId`
      // is `onDelete: SetNull`, so after the disconnect the runner resolves a
      // null account — which is exactly why `loadSendCipher` now REFUSES an
      // unresolved account in a multi-account workspace (missing:
      // "account-unresolved"). Before that guard the campaign silently sent
      // from whichever number happened to be default: a billed, irreversible
      // mass send from a sender the audience never messaged. Worth naming
      // BEFORE the credentials go, not after.
      this.db.broadcast.count({
        where: {
          workspaceId,
          channelConnectionId: id,
          status: { in: ["scheduled", "materializing", "queued", "running", "paused"] },
        },
      }),
    ]);
    return { conversations, openConversations, scheduledBroadcasts };
  }

  /**
   * The same three counts for EVERY account on a channel — what the
   * channel-level "Disconnect" actually destroys.
   *
   * That button deletes every `ChannelConnection` on the channel, not one. With
   * `onDelete: SetNull` on both pointers, it strands every thread on the channel
   * (`account-unresolved` on the next reply) and nulls every scheduled
   * campaign's sender. The per-account `remove()` has had a preflight since
   * multi-account shipped; this route had none, and is strictly more
   * destructive.
   */
  async channelRemovalImpact(
    workspaceId: string,
    channel: AccountChannel,
  ): Promise<{
    accounts: number;
    conversations: number;
    openConversations: number;
    scheduledBroadcasts: number;
  }> {
    const ids = (
      await this.db.channelConnection.findMany({
        where: { workspaceId, channel },
        select: { id: true },
      })
    ).map((c) => c.id);
    if (ids.length === 0) {
      return { accounts: 0, conversations: 0, openConversations: 0, scheduledBroadcasts: 0 };
    }
    const [conversations, openConversations, scheduledBroadcasts] = await Promise.all([
      this.db.conversation.count({
        where: { workspaceId, channelConnectionId: { in: ids } },
      }),
      this.db.conversation.count({
        where: {
          workspaceId,
          channelConnectionId: { in: ids },
          status: { not: "closed" },
        },
      }),
      this.db.broadcast.count({
        where: {
          workspaceId,
          channelConnectionId: { in: ids },
          status: { in: ["scheduled", "materializing", "queued", "running", "paused"] },
        },
      }),
    ]);
    return { accounts: ids.length, conversations, openConversations, scheduledBroadcasts };
  }

  /** Rename an account (display only — never touches credentials or routing). */
  async rename(
    workspaceId: string,
    channel: AccountChannel,
    id: string,
    label: string | null,
  ): Promise<void> {
    const res = await this.db.channelConnection.updateMany({
      where: { id, workspaceId, channel },
      data: { label: label?.trim() || null },
    });
    if (res.count === 0) throw new NotFoundException({ error: "account_not_found" });
    // The label IS what agents see in the inbox chip — a rename nobody sees is
    // a rename that didn't happen.
    await this.announce(workspaceId);
  }

  /**
   * Make `id` the channel's default account — the one outbound-initiated sends
   * and broadcasts use when no thread names an account.
   *
   * Both writes run in ONE transaction: clearing the old default and setting the
   * new one must not be observable apart, or a concurrent compose-new would find
   * either zero defaults (send_account_unresolved) or two.
   */
  async setDefault(workspaceId: string, channel: AccountChannel, id: string): Promise<void> {
    const target = await this.db.channelConnection.findFirst({
      where: { id, workspaceId, channel },
      select: { id: true, isActive: true },
    });
    if (!target) throw new NotFoundException({ error: "account_not_found" });
    if (!target.isActive) {
      throw new BadRequestException({ error: "account_inactive" });
    }
    await this.db.$transaction([
      this.db.channelConnection.updateMany({
        where: { workspaceId, channel, isDefault: true },
        data: { isDefault: false },
      }),
      this.db.channelConnection.update({ where: { id }, data: { isDefault: true } }),
    ]);
    this.bustCache(workspaceId, channel);
    await this.announce(workspaceId);
  }

  /**
   * Disconnect an account.
   *
   * The row is DELETED, not soft-disabled: its credentials are the thing being
   * revoked. Conversations survive — `Conversation.channelConnectionId` is
   * SetNull — and they become unsendable rather than silently falling back to a
   * sibling number, which would reply to a customer from a number they never
   * messaged.
   *
   * That last promise is enforced in `lib/providers/config.ts` (and the
   * messenger/instagram siblings), NOT here: the FK nulls the column, and a
   * null used to resolve straight to `isDefault: true`. The loader now refuses
   * an unresolved account whenever the workspace has more than one active
   * account on that channel. With a single account the fallback is
   * unambiguous and stays; the state is self-healing either way, because
   * ingest re-stamps the thread's account on the next inbound.
   *
   * Removing the default promotes the oldest remaining account so the channel
   * doesn't end up with accounts but no default.
   */
  async remove(workspaceId: string, channel: AccountChannel, id: string): Promise<void> {
    const target = await this.db.channelConnection.findFirst({
      where: { id, workspaceId, channel },
      select: {
        id: true,
        isDefault: true,
        externalAccountId: true,
        config: true,
        secrets: true,
        wabaAccount: { select: { id: true, externalWabaId: true } },
      },
    });
    if (!target) throw new NotFoundException({ error: "account_not_found" });

    await this.db.$transaction(async (tx) => {
      await tx.channelConnection.delete({ where: { id } });
      if (!target.isDefault) return;
      // Promote only a VIABLE successor. `setDefault` requires `isActive`, and
      // `normalizeDefaultAccount` additionally hunts for a real
      // `externalAccountId` — this path had neither guard, so if the oldest row
      // happened to be an inactive account or a credential-less `""`
      // placeholder it became the channel default. `getMetaWebhookConfig`
      // reads `isDefault: true` and returns null on `!isActive`, so that ends
      // in a 403 on every webhook and ALL INBOUND SILENTLY LOST — the exact
      // failure the `""`-placeholder bug caused once already.
      const next = await tx.channelConnection.findFirst({
        where: {
          workspaceId,
          channel,
          isActive: true,
          externalAccountId: { not: "" },
        },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (next) {
        await tx.channelConnection.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    });
    // RELEASE the webhook subscription — the half of the lifecycle that was
    // missing. Connecting asserts the subscription; nothing released it, so Meta
    // kept POSTing this account's customer messages forever. Ingest dropped them
    // fail-soft as `unknown_account`, but we were still receiving and parsing the
    // message content of an account the operator had removed.
    //
    // AFTER the delete, so the "is anyone else still using this?" checks below see
    // the post-removal world. Best-effort: a Graph failure must never turn a
    // completed removal into an error.
    await this.releaseSubscription(workspaceId, channel, target).catch((err) => {
      this.logger.warn(
        `[${workspaceId}] could not release ${channel} webhook subscription: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    // The portfolio FK is SetNull — removing the last number under a
    // WhatsApp portfolio strands its row (and the panel's "shared by N
    // numbers" framing reads the stale count). GC any now-orphaned rows.
    if (channel === "whatsapp") await gcOrphanWhatsappPortfolios(workspaceId);
    this.bustCache(workspaceId, channel);
    await this.announce(workspaceId);
  }

  /**
   * Tell Meta to stop sending webhooks for an account we just removed.
   *
   * Scoped by what each subscription actually covers, which differs per channel:
   *
   *  - WhatsApp: the subscription is per WABA, and numbers under one WABA SHARE it.
   *    Release only when no active connection still points at that WABA, or a
   *    sibling number goes dark.
   *  - Messenger / Instagram: the subscription is per PAGE, and the two channels can
   *    share one Page. Release only when neither channel still uses it —
   *    `releasePageSubscription` is a no-op while the sibling is connected, because
   *    the field set is a single shared union with no per-channel subset to subtract.
   *
   * Best-effort throughout: this runs AFTER the row is gone, so any failure leaves
   * exactly the pre-existing behaviour (Meta keeps sending; ingest drops as
   * `unknown_account`) rather than breaking the removal.
   */
  private async releaseSubscription(
    workspaceId: string,
    channel: AccountChannel,
    target: {
      externalAccountId: string;
      config: Prisma.JsonValue;
      secrets: Prisma.JsonValue;
      wabaAccount: { id: string; externalWabaId: string } | null;
    },
  ): Promise<void> {
    const secrets = (target.secrets ?? {}) as { accessToken?: string; pageAccessToken?: string };
    const cipher = secrets.accessToken ?? secrets.pageAccessToken ?? null;
    if (!cipher) return;
    let accessToken: string;
    try {
      accessToken = decryptSecret(cipher);
    } catch {
      return; // undecryptable — nothing we can authenticate with
    }

    if (channel === "whatsapp") {
      if (!target.wabaAccount) return;
      const siblings = await this.db.channelConnection.count({
        where: { workspaceId, channel: "whatsapp", wabaAccountId: target.wabaAccount.id },
      });
      if (siblings > 0) return; // another number still needs this WABA's webhooks
      await releaseWabaSubscription(
        target.wabaAccount.externalWabaId,
        accessToken,
        GRAPH_VERSION,
      );
      return;
    }

    // Social: the Page is the subscription unit and both channels may share it.
    const pageId = (target.config as { pageId?: string } | null)?.pageId;
    if (!pageId) return;
    const stillInUse =
      (await this.db.channelConnection.count({
        where: {
          workspaceId,
          channel: { in: ["messenger", "instagram"] },
          config: { path: ["pageId"], equals: pageId },
        },
      })) > 0;
    await releasePageSubscription(pageId, accessToken, GRAPH_VERSION, { stillInUse });
  }

  /**
   * The workspace's connected accounts across EVERY channel, display fields
   * only — no credentials, no verify token, no WABA id.
   *
   * Separate from `list()` because the audiences are different. `list()` is the
   * admin's management view and is `@RequireRole("admin")`; this is what every
   * AGENT needs so the inbox can say "this thread came in on Sales · +1 555…".
   * Without it a workspace running two numbers gives its agents no way to tell
   * which one a customer is talking to — and they reply blind.
   *
   * Deliberately returned as one small array rather than joined per
   * conversation: a workspace has a handful of accounts, the inbox list is the
   * hottest read in the app, and `Conversation.channelConnectionId` is already a
   * scalar on the row. One cached fetch + a client-side map beats widening every
   * list row with a relation.
   */
  async directory(workspaceId: string): Promise<ChannelAccountDirectoryEntry[]> {
    const rows = await this.db.channelConnection.findMany({
      where: { workspaceId },
      orderBy: [{ channel: "asc" }, { isDefault: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        channel: true,
        externalAccountId: true,
        label: true,
        isDefault: true,
        isActive: true,
        needsReconnect: true,
        config: true,
      },
    });
    return rows
      // The credential-less placeholder `getConfig` pre-mints on a settings-page
      // load is not an account anyone can be messaging on. See
      // normalizeDefaultAccount.
      .filter((r) => r.externalAccountId.length > 0)
      .map((r) => {
        const providerName = channelAccountProviderName(r.config);
        return {
          id: r.id,
          channel: r.channel,
          // What an agent should SEE. The admin's label wins when set (that is
          // the whole point of labelling "Sales line"), then the provider's own
          // human name, then the raw id as a last resort — never blank.
          name: channelAccountDisplayName(r)!,
          /** The provider's human identifier, shown as the subtitle when a label
           *  is set so "Sales line" is still traceable to a real number. */
          providerName,
          isDefault: r.isDefault,
          isActive: r.isActive,
          // The agent-facing trust signal: an expired token means replies on
          // this account's threads will fail until an admin reconnects. Set
          // per-connection by the send paths (Graph 190), cleared on a
          // successful send or a fresh credential save.
          needsReconnect: r.needsReconnect,
        };
      });
  }

  /** Credentials are cached per account; every channel keeps its own cache. */
  private bustCache(workspaceId: string, channel: AccountChannel): void {
    if (channel === "whatsapp") invalidateProviderConfig(workspaceId);
    else if (channel === "messenger") invalidateMessengerConfig(workspaceId);
    else invalidateInstagramConfig(workspaceId);
  }
}
