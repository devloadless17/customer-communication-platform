import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

import { parseMentions } from "@ccp/shared/team-chat/mentions";
import {
  canDeleteChannel,
  canDeleteMessage,
  canEditMessage,
  canManageChannel,
  canPinMessage,
  EDIT_WINDOW_MS,
} from "@ccp/shared/team-chat/permissions";
import {
  buildMessagePreview,
  decodeCursor,
  getDefaultChannel,
  listChannelMessages,
  listChannelMessagesAfter,
  listChannelsForUser,
  loadMessageForEmit,
  mapChannel,
} from "@/lib/team-chat/queries";
import {
  DEFAULT_CHANNEL_NAME,
  isValidChannelName,
  normalizeChannelName,
} from "@ccp/shared/team-chat/types";
import type { Role } from "@ccp/shared/types";

import { EventBus } from "../events/event-bus.module";
import { PrismaService } from "../prisma/prisma.service";
import type {
  CreateChannelInput,
  EditChannelMessageInput,
  PostChannelMessageInput,
  ToggleReactionInput,
  UpdateChannelInput,
} from "./channels.schemas";

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EventBus,
  ) {}

  // ---- Channels ---------------------------------------------------------

  list(teamId: string, userId: string) {
    return listChannelsForUser(teamId, userId);
  }

  /**
   * Resolve the team's default channel — the one `/team` redirects into on
   * first load. Falls back to alphabetically-first if no `isDefault` row
   * exists (defensive — see getDefaultChannel in queries.ts).
   */
  getDefault(teamId: string) {
    return getDefaultChannel(teamId);
  }

  async create(
    teamId: string,
    userId: string,
    role: Role,
    input: CreateChannelInput,
  ) {
    // Channel-create gate is per-role — not all members can create channels.
    if (!canManageChannel(role)) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    const name = normalizeChannelName(input.name);
    if (!isValidChannelName(name)) {
      throw new BadRequestException({
        error: "invalid_name",
        detail:
          "Channel names must be lowercase letters, digits, or dashes (1–32 chars).",
      });
    }
    const description = input.description?.length ? input.description : null;

    try {
      const created = await this.prisma.teamChannel.create({
        data: { teamId, name, description, createdById: userId },
      });
      await this.bus.publish({
        type: "team.catalog_changed",
        teamId,
        scope: "team-channels",
      });
      return mapChannel(created);
    } catch (err) {
      if (isP2002(err)) {
        throw new ConflictException({
          error: "name_taken",
          detail: "A channel with that name already exists.",
        });
      }
      throw err;
    }
  }

  async update(
    teamId: string,
    role: Role,
    channelId: string,
    input: UpdateChannelInput,
  ) {
    if (!canManageChannel(role)) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    const existing = await this.prisma.teamChannel.findFirst({
      where: { id: channelId, teamId },
    });
    if (!existing) throw new NotFoundException({ error: "channel not found" });

    const data: { name?: string; description?: string | null } = {};

    if (input.name !== undefined) {
      const candidate = normalizeChannelName(input.name);
      if (!isValidChannelName(candidate)) {
        throw new BadRequestException({ error: "invalid_name" });
      }
      // Hard-protect the default channel — rename refuses to change its name.
      if (existing.isDefault && candidate !== existing.name) {
        throw new ConflictException({
          error: "default_channel_locked",
          detail: "The default channel can't be renamed.",
        });
      }
      if (candidate !== existing.name) data.name = candidate;
    }
    if (input.description !== undefined) {
      data.description = input.description.length ? input.description : null;
    }

    if (Object.keys(data).length === 0) {
      return mapChannel(existing);
    }

    let updated;
    try {
      updated = await this.prisma.teamChannel.update({ where: { id: channelId }, data });
    } catch (err) {
      if (isP2002(err)) throw new ConflictException({ error: "name_taken" });
      throw err;
    }

    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
      scope: "team-channels",
    });
    return mapChannel(updated);
  }

  async remove(teamId: string, role: Role, channelId: string): Promise<void> {
    if (!canDeleteChannel(role)) throw new ForbiddenException({ error: "forbidden" });

    const existing = await this.prisma.teamChannel.findFirst({
      where: { id: channelId, teamId },
    });
    if (!existing) throw new NotFoundException({ error: "channel not found" });
    // Hard-protect the default channel from deletion — same reason as rename.
    if (existing.isDefault || existing.name === DEFAULT_CHANNEL_NAME) {
      throw new ConflictException({
        error: "default_channel_locked",
        detail: "The default channel can't be deleted.",
      });
    }
    // FK cascades take care of messages / mentions / reactions / pins /
    // receipts in one shot — single DELETE.
    await this.prisma.teamChannel.delete({ where: { id: channelId } });
    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
      scope: "team-channels",
    });
  }

  // ---- Messages ---------------------------------------------------------

  async listMessages(
    teamId: string,
    channelId: string,
    opts: { after?: string; before?: string; take?: number },
  ) {
    await this.requireChannelOwnership(teamId, channelId);

    if (opts.after) {
      if (Number.isNaN(Date.parse(opts.after))) {
        throw new BadRequestException({ error: "invalid after" });
      }
      const items = await listChannelMessagesAfter(channelId, teamId, opts.after);
      return { items };
    }

    const before = opts.before ? decodeCursor(opts.before) : null;
    if (opts.before && !before) {
      throw new BadRequestException({ error: "invalid cursor" });
    }
    return listChannelMessages(channelId, teamId, {
      take: opts.take,
      before,
    });
  }

  async postMessage(
    teamId: string,
    userId: string,
    channelId: string,
    input: PostChannelMessageInput,
  ) {
    const receivedAt = new Date();
    await this.requireChannelOwnership(teamId, channelId);

    // Body is authoritative for mentions — re-parse it server-side and
    // intersect with team membership so a body crafted to ping someone in
    // another team is a no-op.
    const validMentionIds = await this.validateMentions(teamId, input.body);

    const preview = buildMessagePreview(input.body, false);
    const created = await this.prisma.$transaction(async (tx) => {
      const msg = await tx.teamChannelMessage.create({
        data: {
          channelId,
          teamId,
          authorUserId: userId,
          body: input.body,
          createdAt: receivedAt,
        },
        select: { id: true },
      });
      if (validMentionIds.length > 0) {
        await tx.teamChannelMention.createMany({
          data: validMentionIds.map((uid) => ({
            messageId: msg.id,
            mentionedUserId: uid,
          })),
          skipDuplicates: true,
        });
      }
      await tx.teamChannel.update({
        where: { id: channelId },
        data: { lastMessageAt: receivedAt, lastMessagePreview: preview },
      });
      return msg;
    });

    const dto = await loadMessageForEmit(created.id, teamId);
    if (!dto) {
      this.logger.error("post-write reload returned null");
      return { messageId: created.id };
    }

    await this.bus.publish({
      type: "team_channel.message_created",
      teamId,
      channelId,
      message: dto,
      preview,
      lastMessageAt: receivedAt.toISOString(),
      threadReplyCount: 0,
      ...(input.clientTempId ? { clientTempId: input.clientTempId } : {}),
    });

    return { messageId: created.id, message: dto };
  }

  async editMessage(
    teamId: string,
    userId: string,
    channelId: string,
    messageId: string,
    input: EditChannelMessageInput,
  ) {
    const existing = await this.prisma.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, teamId },
      select: {
        id: true,
        authorUserId: true,
        createdAt: true,
        threadRootId: true,
        mediaKind: true,
      },
    });
    if (!existing) throw new NotFoundException({ error: "message not found" });

    if (!canEditMessage(existing.authorUserId, userId, existing.createdAt)) {
      if (existing.authorUserId !== userId) {
        throw new ForbiddenException({ error: "forbidden" });
      }
      throw new UnprocessableEntityException({
        error: "edit_window_closed",
        detail: `Messages can be edited for ${Math.round(EDIT_WINDOW_MS / 1000 / 60 / 60)} hours after sending.`,
      });
    }

    const validMentionIds = await this.validateMentions(teamId, input.body);
    const editedAt = new Date();

    await this.prisma.$transaction([
      this.prisma.teamChannelMessage.update({
        where: { id: messageId },
        data: { body: input.body, editedAt },
      }),
      this.prisma.teamChannelMention.deleteMany({ where: { messageId } }),
      ...(validMentionIds.length > 0
        ? [
            this.prisma.teamChannelMention.createMany({
              data: validMentionIds.map((uid) => ({
                messageId,
                mentionedUserId: uid,
              })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);

    // Refresh channel preview if this is the latest top-level message.
    // Thread replies don't surface in the preview.
    if (existing.threadRootId === null) {
      const latest = await this.prisma.teamChannelMessage.findFirst({
        where: { channelId, threadRootId: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, body: true, mediaKind: true },
      });
      if (latest?.id === messageId) {
        await this.prisma.teamChannel.update({
          where: { id: channelId },
          data: {
            lastMessagePreview: buildMessagePreview(input.body, !!existing.mediaKind),
          },
        });
      }
    }

    await this.bus.publish({
      type: "team_channel.message_edited",
      teamId,
      channelId,
      messageId,
      body: input.body,
      editedAt: editedAt.toISOString(),
    });
    const dto = await loadMessageForEmit(messageId, teamId);
    return { message: dto };
  }

  async deleteMessage(
    teamId: string,
    userId: string,
    role: Role,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const existing = await this.prisma.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, teamId },
      select: { id: true, authorUserId: true, threadRootId: true },
    });
    if (!existing) throw new NotFoundException({ error: "message not found" });

    if (!canDeleteMessage(role, existing.authorUserId, userId)) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    await this.prisma.teamChannelMessage.delete({ where: { id: messageId } });

    if (existing.threadRootId) {
      // Reply delete → decrement root's counter so the "X replies" pill stays honest.
      await this.prisma.teamChannelMessage
        .update({
          where: { id: existing.threadRootId },
          data: { threadReplyCount: { decrement: 1 } },
        })
        .catch((err) =>
          this.logger.error(`decrement threadReplyCount failed: ${err instanceof Error ? err.message : err}`),
        );
    } else {
      // Top-level delete → refresh channel preview to whatever's now latest.
      const latest = await this.prisma.teamChannelMessage.findFirst({
        where: { channelId, threadRootId: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { body: true, mediaKind: true, createdAt: true },
      });
      await this.prisma.teamChannel.update({
        where: { id: channelId },
        data: latest
          ? {
              lastMessageAt: latest.createdAt,
              lastMessagePreview: buildMessagePreview(latest.body, !!latest.mediaKind),
            }
          : { lastMessagePreview: "" },
      });
    }

    await this.bus.publish({
      type: "team_channel.message_deleted",
      teamId,
      channelId,
      messageId,
      threadRootId: existing.threadRootId,
    });
  }

  // ---- Pins -------------------------------------------------------------

  async pinMessage(
    teamId: string,
    userId: string,
    role: Role,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    if (!canPinMessage(role)) throw new ForbiddenException({ error: "forbidden" });

    const msg = await this.prisma.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, teamId },
      select: { id: true, threadRootId: true },
    });
    if (!msg) throw new NotFoundException({ error: "message not found" });
    if (msg.threadRootId !== null) {
      throw new BadRequestException({
        error: "thread_reply_unpinnable",
        detail: "Only top-level messages can be pinned.",
      });
    }

    try {
      await this.prisma.teamChannelPin.create({
        data: { channelId, messageId, pinnedById: userId },
      });
    } catch (err) {
      if (!isP2002(err)) throw err;
      // Already pinned — idempotent success.
    }
    await this.bus.publish({
      type: "team_channel.pin_changed",
      teamId,
      channelId,
      messageId,
      pinned: true,
    });
  }

  async unpinMessage(
    teamId: string,
    role: Role,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    if (!canPinMessage(role)) throw new ForbiddenException({ error: "forbidden" });

    // Tenant guard via the message — keeps unpin from teaching the caller
    // about another team's message ids.
    const msg = await this.prisma.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, teamId },
      select: { id: true },
    });
    if (!msg) throw new NotFoundException({ error: "message not found" });

    await this.prisma.teamChannelPin.deleteMany({ where: { messageId } });
    await this.bus.publish({
      type: "team_channel.pin_changed",
      teamId,
      channelId,
      messageId,
      pinned: false,
    });
  }

  // ---- Reactions --------------------------------------------------------

  async toggleReaction(
    teamId: string,
    userId: string,
    channelId: string,
    messageId: string,
    input: ToggleReactionInput,
  ): Promise<{ emoji: string; userIds: string[] }> {
    const message = await this.prisma.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, teamId },
      select: { id: true },
    });
    if (!message) throw new NotFoundException({ error: "message not found" });

    const { emoji } = input;
    const existing = await this.prisma.teamChannelReaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.teamChannelReaction.delete({ where: { id: existing.id } });
    } else {
      try {
        await this.prisma.teamChannelReaction.create({
          data: { messageId, userId, emoji },
        });
      } catch (err) {
        // Raced with another of my tabs — already exists. Treat as success.
        if (!isP2002(err)) throw err;
      }
    }

    // Full snapshot per emoji — receivers don't need a delta reducer.
    const reactions = await this.prisma.teamChannelReaction.findMany({
      where: { messageId, emoji },
      select: { userId: true },
    });
    const userIds = reactions.map((r) => r.userId);

    await this.bus.publish({
      type: "team_channel.reaction_changed",
      teamId,
      channelId,
      messageId,
      emoji,
      userIds,
    });

    return { emoji, userIds };
  }

  // ---- helpers ----------------------------------------------------------

  /** Throw 404 if the channel doesn't exist in this team. */
  private async requireChannelOwnership(teamId: string, channelId: string): Promise<void> {
    const channel = await this.prisma.teamChannel.findFirst({
      where: { id: channelId, teamId },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException({ error: "channel not found" });
  }

  /** Parse mentions from body + intersect with this team's membership. */
  private async validateMentions(teamId: string, body: string): Promise<string[]> {
    const parsed = parseMentions(body);
    const ids = Array.from(new Set(parsed.map((m) => m.userId)));
    if (ids.length === 0) return [];
    const members = await this.prisma.user.findMany({
      where: { teamId, id: { in: ids } },
      select: { id: true },
    });
    return members.map((u) => u.id);
  }
}

function isP2002(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}
