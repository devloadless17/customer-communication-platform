import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { invalidateProviderConfig } from "@/lib/providers/config";
import {
  gcOrphanWhatsappPortfolios,
  portfolioTemplateLimit,
} from "@/lib/providers/meta-health";
import { invalidateMessengerConfig } from "@/lib/providers/messenger-config";
import { invalidateInstagramConfig } from "@/lib/providers/instagram-config";
import type { Channel } from "@ccp/shared/types";

import { DbService } from "../../db/db.service";

/** Channels whose accounts are ChannelConnection rows (webchat uses WebchatWidget). */
export type AccountChannel = "whatsapp" | "messenger" | "instagram";

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
  createdAt: string;
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
}

@Injectable()
export class ChannelAccountsService {
  constructor(private readonly db: DbService) {}

  /** Every account a workspace has connected on `channel`, default first. */
  async list(workspaceId: string, channel: AccountChannel): Promise<ChannelAccountDto[]> {
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
        wabaId: true,
        config: true,
        createdAt: true,
        qualityRating: true,
        throughputLevel: true,
        messagingHealthUpdatedAt: true,
        portfolio: {
          select: {
            externalPortfolioId: true,
            messagingTier: true,
            messagingDailyCap: true,
            verificationStatus: true,
            _count: { select: { connections: true } },
          },
        },
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
      wabaId: r.wabaId,
      createdAt: r.createdAt.toISOString(),
      // Only WhatsApp carries messaging health; the social channels have no
      // equivalent from Meta, so `null` means "not applicable", not "unknown".
      health:
        channel !== "whatsapp"
          ? null
          : {
              qualityRating: r.qualityRating,
              throughputLevel: r.throughputLevel,
              updatedAt: r.messagingHealthUpdatedAt?.toISOString() ?? null,
              portfolio: r.portfolio
                ? {
                    externalId: r.portfolio.externalPortfolioId,
                    messagingTier: r.portfolio.messagingTier,
                    messagingDailyCap: r.portfolio.messagingDailyCap,
                    verificationStatus: r.portfolio.verificationStatus,
                    templateLimit: portfolioTemplateLimit(r.portfolio.verificationStatus),
                    accountCount: r.portfolio._count.connections,
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
      select: { id: true, isDefault: true },
    });
    if (!target) throw new NotFoundException({ error: "account_not_found" });

    await this.db.$transaction(async (tx) => {
      await tx.channelConnection.delete({ where: { id } });
      if (!target.isDefault) return;
      const next = await tx.channelConnection.findFirst({
        where: { workspaceId, channel },
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
    // The portfolio FK is SetNull — removing the last number under a
    // WhatsApp portfolio strands its row (and the panel's "shared by N
    // numbers" framing reads the stale count). GC any now-orphaned rows.
    if (channel === "whatsapp") await gcOrphanWhatsappPortfolios(workspaceId);
    this.bustCache(workspaceId, channel);
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
        config: true,
      },
    });
    return rows
      // The credential-less placeholder `getConfig` pre-mints on a settings-page
      // load is not an account anyone can be messaging on. See
      // normalizeDefaultAccount.
      .filter((r) => r.externalAccountId.length > 0)
      .map((r) => {
        const cfg = (r.config ?? {}) as {
          displayPhoneNumber?: string;
          pageName?: string;
          igUsername?: string;
        };
        const providerName =
          cfg.displayPhoneNumber ??
          cfg.pageName ??
          (cfg.igUsername ? `@${cfg.igUsername}` : undefined) ??
          null;
        return {
          id: r.id,
          channel: r.channel,
          // What an agent should SEE. The admin's label wins when set (that is
          // the whole point of labelling "Sales line"), then the provider's own
          // human name, then the raw id as a last resort — never blank.
          name: r.label ?? providerName ?? r.externalAccountId,
          /** The provider's human identifier, shown as the subtitle when a label
           *  is set so "Sales line" is still traceable to a real number. */
          providerName,
          isDefault: r.isDefault,
          isActive: r.isActive,
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
