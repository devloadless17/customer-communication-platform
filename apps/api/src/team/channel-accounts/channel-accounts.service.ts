import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { invalidateProviderConfig } from "@/lib/providers/config";
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
    }));
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
   * SetNull — but they become unsendable (`send_account_unresolved`) rather than
   * silently falling back to a sibling number, which would reply to a customer
   * from a number they never messaged.
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
    this.bustCache(workspaceId, channel);
  }

  /** Credentials are cached per account; every channel keeps its own cache. */
  private bustCache(workspaceId: string, channel: AccountChannel): void {
    if (channel === "whatsapp") invalidateProviderConfig(workspaceId);
    else if (channel === "messenger") invalidateMessengerConfig(workspaceId);
    else invalidateInstagramConfig(workspaceId);
  }
}
