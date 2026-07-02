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
import { blobStorage } from "@/lib/blob-storage";
import { MEDIA_SIZE_CAPS, kindFromMime } from "@/lib/media-storage";
import {
  buildMessagePreview,
  decodeCursor,
  getChannelById,
  getDefaultChannel,
  listChannelMessages,
  listChannelMessagesAfter,
  listChannelMessagesAround,
  listChannelPins,
  listChannelsForUser,
  listThreadReplies as queryListThreadReplies,
  loadMessageForEmit,
  mapChannel,
  searchAllChannels,
  searchChannelMessages,
} from "@/lib/team-chat/queries";
import {
  DEFAULT_CHANNEL_NAME,
  isValidChannelName,
  normalizeChannelName,
} from "@ccp/shared/team-chat/types";
import type { Role } from "@ccp/shared/types";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import type { ApiSession } from "../auth/session.guard";
import type { TeamChannelMessageDto } from "@ccp/shared/team-chat/types";
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
    private readonly db: DbService,
    private readonly bus: EventBus,
    private readonly realtime: RealtimeGateway,
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

  /**
   * Fetch a single channel by id (scoped to team). Returns null when the
   * id is foreign — controller turns that into 404.
   */
  async getById(teamId: string, userId: string, channelId: string) {
    await this.requireChannelMembership(teamId, userId, channelId);
    return getChannelById(channelId, teamId);
  }

  /**
   * Pinned messages for a channel, newest-pin first. Each entry carries
   * the full message DTO so the pins panel renders without extra fetches.
   */
  async listPins(teamId: string, userId: string, channelId: string) {
    await this.requireChannelMembership(teamId, userId, channelId);
    return listChannelPins(channelId, teamId);
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

    // Validate the proposed extra members BEFORE the transaction so the
    // channel-create rollback is clean. Self is added even if not listed,
    // and duplicates are deduped — we only need to confirm every id is a
    // real, non-deactivated user on this team.
    const requestedMemberIds = new Set<string>(input.memberUserIds ?? []);
    requestedMemberIds.add(userId);
    const memberIds = [...requestedMemberIds];
    if (memberIds.length > 1) {
      const validCount = await this.db.user.count({
        where: { id: { in: memberIds }, teamId, deactivatedAt: null },
      });
      if (validCount !== memberIds.length) {
        throw new BadRequestException({
          error: "invalid_member",
          detail: "One or more selected members aren't on this team.",
        });
      }
    }

    try {
      const created = await this.db.$transaction(async (tx) => {
        const channel = await tx.teamChannel.create({
          data: { teamId, name, description, createdById: userId },
        });
        await tx.teamChannelMember.createMany({
          data: memberIds.map((id) => ({
            channelId: channel.id,
            userId: id,
            addedById: userId,
          })),
        });
        return channel;
      });
      await this.bus.publish({
        type: "team.catalog_changed",
        teamId,
        scope: "team-channels",
      });
      // Members joining a brand-new channel doesn't need a separate
      // members_changed fan-out — the catalog_changed event already triggers
      // every connected client to refetch its channel list, which carries the
      // new memberCount + visibility for the newly-added members.
      return mapChannel(created, memberIds.length);
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

  // ---- Members ----------------------------------------------------------

  /**
   * List members of a channel. Gated on channel membership: a non-member must
   * not be able to enumerate a PRIVATE channel's full roster (names + emails) —
   * `requireChannelMembership` 404s them, and 404 (not 403) doesn't even teach
   * a non-member that the channel exists (L2). Default/public channels stay
   * listable for everyone — `requireChannelMembership` short-circuits the
   * membership join for `isDefault` channels (every team member is implicitly a
   * member). Returns rows ordered by addedAt desc (most-recently-added first).
   */
  async listMembers(teamId: string, viewerUserId: string, channelId: string) {
    await this.requireChannelMembership(teamId, viewerUserId, channelId);
    const rows = await this.db.teamChannelMember.findMany({
      where: { channelId },
      include: {
        user: {
          select: { id: true, name: true, email: true, role: true, avatarUrl: true },
        },
      },
      orderBy: [{ addedAt: "desc" }, { userId: "asc" }],
    });
    return rows.map((r) => ({
      channelId: r.channelId,
      userId: r.userId,
      name: r.user.name,
      email: r.user.email,
      role: r.user.role,
      avatarUrl: r.user.avatarUrl ?? null,
      addedAt: r.addedAt.toISOString(),
      addedById: r.addedById,
      isSelf: r.userId === viewerUserId,
    }));
  }

  /**
   * Add members to a channel. Admin/manager only — checked at the route, but
   * re-checked here so a future direct caller can't skip the gate. Adds are
   * idempotent: re-adding someone is a no-op (skipDuplicates), and the event
   * payload only carries ids that were actually new so the UI doesn't toast
   * "added 0 people."
   */
  async addMembers(
    teamId: string,
    actorUserId: string,
    role: Role,
    channelId: string,
    userIds: string[],
  ): Promise<{ added: string[] }> {
    if (!canManageChannel(role)) throw new ForbiddenException({ error: "forbidden" });
    await this.requireChannelInTeam(teamId, channelId);

    const ids = [...new Set(userIds)];
    if (ids.length === 0) return { added: [] };

    const validUsers = await this.db.user.findMany({
      where: { id: { in: ids }, teamId, deactivatedAt: null },
      select: { id: true },
    });
    if (validUsers.length !== ids.length) {
      throw new BadRequestException({
        error: "invalid_member",
        detail: "One or more selected users aren't on this team.",
      });
    }

    const existing = await this.db.teamChannelMember.findMany({
      where: { channelId, userId: { in: ids } },
      select: { userId: true },
    });
    const alreadyIn = new Set(existing.map((e) => e.userId));
    const toAdd = ids.filter((id) => !alreadyIn.has(id));

    if (toAdd.length > 0) {
      await this.db.teamChannelMember.createMany({
        data: toAdd.map((id) => ({ channelId, userId: id, addedById: actorUserId })),
        skipDuplicates: true,
      });
      await this.bus.publish({
        type: "team_channel.members_changed",
        teamId,
        channelId,
        action: "added",
        userIds: toAdd,
        changedById: actorUserId,
      });
    }
    return { added: toAdd };
  }

  /**
   * Remove a member from a channel. Admin/manager only. Self-removal ("leave
   * channel") is allowed for any role — the route passes the actor's own
   * userId and we permit that path even without canManageChannel.
   *
   * The default channel is protected: no one — admin or self — can be removed.
   * This keeps #general as the always-available landing channel for every
   * team member; demoting it requires deleting/renaming the row.
   */
  async removeMember(
    teamId: string,
    actorUserId: string,
    role: Role,
    channelId: string,
    targetUserId: string,
  ): Promise<void> {
    const channel = await this.requireChannelInTeam(teamId, channelId);

    const isSelfLeave = actorUserId === targetUserId;
    if (!isSelfLeave && !canManageChannel(role)) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    if (channel.isDefault) {
      throw new ConflictException({
        error: "default_channel_locked",
        detail: "Members can't leave or be removed from the default channel.",
      });
    }

    const existing = await this.db.teamChannelMember.findUnique({
      where: { channelId_userId: { channelId, userId: targetUserId } },
      select: { userId: true },
    });
    if (!existing) {
      throw new NotFoundException({ error: "not_a_member" });
    }

    await this.db.teamChannelMember.delete({
      where: { channelId_userId: { channelId, userId: targetUserId } },
    });
    await this.bus.publish({
      type: "team_channel.members_changed",
      teamId,
      channelId,
      action: "removed",
      userIds: [targetUserId],
      changedById: actorUserId,
    });
    // Force the removed user's live sockets to leave the channel room so
    // they stop receiving channel frames before they next reload. Without
    // this, the kicked tab keeps seeing every new message until refresh.
    this.realtime.evictUserFromChannelRoom(targetUserId, channelId);
  }

  private async requireChannelInTeam(teamId: string, channelId: string) {
    const channel = await this.db.teamChannel.findFirst({
      where: { id: channelId, teamId },
      select: { id: true, isDefault: true },
    });
    if (!channel) throw new NotFoundException({ error: "channel not found" });
    return channel;
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

    const existing = await this.db.teamChannel.findFirst({
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
      updated = await this.db.teamChannel.update({ where: { id: channelId }, data });
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

    const existing = await this.db.teamChannel.findFirst({
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
    await this.db.teamChannel.delete({ where: { id: channelId } });
    await this.bus.publish({
      type: "team.catalog_changed",
      teamId,
      scope: "team-channels",
    });
  }

  // ---- Messages ---------------------------------------------------------

  async listMessages(
    teamId: string,
    userId: string,
    channelId: string,
    opts: { after?: string; before?: string; take?: number },
  ) {
    await this.requireChannelMembership(teamId, userId, channelId);

    if (opts.after) {
      // The `?after=` value is EITHER an opaque encoded cursor (from
      // `listChannelMessagesAround`'s `afterCursor` + this path's own
      // `nextCursor` — forward pagination after a search jump-to) OR a bare
      // ISO timestamp (the reconnect-backfill path sends the newest known
      // message's `createdAt`, which carries no id). Decode the keyset form
      // first; fall back to the timestamp form so both callers work.
      const decoded = decodeCursor(opts.after);
      const after = decoded
        ? decoded
        : !Number.isNaN(Date.parse(opts.after))
          ? { createdAt: opts.after, id: null }
          : null;
      if (!after) {
        throw new BadRequestException({ error: "invalid after" });
      }
      // Now returns { items, nextCursor } symmetrically with the
      // ?before= path — client doesn't have to infer pagination state
      // from `items.length >= PAGE_SIZE` anymore.
      return listChannelMessagesAfter(channelId, teamId, after);
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

  /**
   * Idempotent-send dedup. A prior POST reusing this clientTempId already
   * committed: the `TeamChannelMessage_send_idem_key` unique rejected the
   * retry's insert with P2002, which rolled the WHOLE transaction back — so no
   * mention / channel-summary / threadReplyCount side effect double-fired.
   * Reload the original row, re-publish its `message_created` event (so a tab
   * still showing a failed optimistic bubble reconciles by clientTempId once
   * its socket delivers; tabs that already have the row dedupe it by server id),
   * and return the real message — never a duplicate. Returns null if the row
   * somehow isn't found (caller then rethrows the original P2002).
   */
  private async dedupCommittedSend(
    teamId: string,
    userId: string,
    channelId: string,
    clientTempId: string,
  ) {
    const existing = await this.db.teamChannelMessage.findUnique({
      where: {
        channelId_authorUserId_clientTempId: {
          channelId,
          authorUserId: userId,
          clientTempId,
        },
      },
      select: {
        id: true,
        body: true,
        mediaKind: true,
        threadRootId: true,
        createdAt: true,
      },
    });
    if (!existing) return null;
    const dto = await loadMessageForEmit(existing.id, teamId);
    if (!dto) return null;
    const isReply = existing.threadRootId !== null;
    let threadReplyCount = 0;
    if (isReply && existing.threadRootId) {
      const root = await this.db.teamChannelMessage.findUnique({
        where: { id: existing.threadRootId },
        select: { threadReplyCount: true },
      });
      threadReplyCount = root?.threadReplyCount ?? 0;
    }
    await this.bus.publish({
      type: "team_channel.message_created",
      teamId,
      channelId,
      message: dto,
      preview: isReply
        ? null
        : buildMessagePreview(existing.body, existing.mediaKind !== null),
      lastMessageAt: isReply ? null : existing.createdAt.toISOString(),
      threadReplyCount,
      clientTempId,
    });
    return { messageId: existing.id, message: dto };
  }

  /**
   * Latency-tuned hot path. Recipient perception of "instant" is dominated
   * by how soon `bus.publish` fires after the user hits enter. So:
   *   - Parallelize the two pre-write SELECTs (channel ownership + mention
   *     validation) — they're independent.
   *   - Only the message INSERT (+ mention rows, atomically) goes into the
   *     transaction. The channel-preview UPDATE is sidebar UX, not message
   *     UX — moved out and fire-and-forget after the emit.
   *   - Skip `loadMessageForEmit`. We already know every field of the DTO:
   *     ids + body from input, author name/avatar from the session, and
   *     reactions/pin/edits are empty by definition on a fresh row.
   * Net: 2 sequential DB calls (parallel pre-checks → INSERT) instead of 5.
   */
  async postMessage(
    session: ApiSession,
    channelId: string,
    input: PostChannelMessageInput,
  ) {
    const { teamId, userId } = session;
    const receivedAt = new Date();

    const [, validMentionIds] = await Promise.all([
      this.requireChannelMembership(teamId, userId, channelId),
      this.validateMentions(teamId, channelId, input.body),
    ]);

    const preview = buildMessagePreview(input.body, false);
    let created: { id: string };
    try {
      created = await this.db.$transaction(async (tx) => {
        const msg = await tx.teamChannelMessage.create({
          data: {
            channelId,
            teamId,
            authorUserId: userId,
            body: input.body,
            createdAt: receivedAt,
            clientTempId: input.clientTempId ?? null,
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
        // Sidebar summary — bump in the SAME transaction as the insert so
        // `lastMessageAt` can never lag (or silently fail) behind a committed
        // message. A fire-and-forget update here could drop on error, leaving
        // a real unread message with NO sidebar dot (unreadForMe compares
        // lastMessageAt vs the reader's lastReadAt). Mirrors uploadMedia's
        // in-txn bump; a PK update is negligible on the delivery path.
        await tx.teamChannel.update({
          where: { id: channelId },
          data: { lastMessageAt: receivedAt, lastMessagePreview: preview },
        });
        // Advance the AUTHOR's own read receipt to their post time — posting is
        // proof they're viewing the channel (mirrors the inbox's
        // markReadOnAgentSend). Without this the sender's own channel shows
        // badged-unread on SSR/reload (unreadForMe compares the channel's
        // lastMessageAt, which THIS post just bumped, against the reader's
        // lastReadAt). receivedAt is `now`, so this never moves the receipt
        // backward. In the same tx so it can't lag or drop behind the commit.
        await tx.teamChannelReadReceipt.upsert({
          where: { userId_channelId: { userId, channelId } },
          create: { userId, channelId, lastReadAt: receivedAt },
          update: { lastReadAt: receivedAt },
        });
        return msg;
      });
    } catch (err) {
      // Idempotent retry: this clientTempId already committed (the send-idem
      // unique rejected the insert with P2002, rolling the whole tx back).
      const dedup =
        input.clientTempId && isP2002(err)
          ? await this.dedupCommittedSend(teamId, userId, channelId, input.clientTempId)
          : null;
      if (dedup) return dedup;
      throw err;
    }

    const dto = buildFreshMessageDto({
      id: created.id,
      channelId,
      teamId,
      session,
      body: input.body,
      mentionedUserIds: validMentionIds,
      createdAt: receivedAt,
    });

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
    // Membership check FIRST (mirrors deleteMessage). A non-member must not be
    // able to distinguish, via the 403-forbidden vs 422-edit_window error
    // codes, whether a message in a private channel they were removed from
    // still exists or whether its edit window is open. requireChannelMembership
    // 404s a non-member before any message lookup leaks that signal.
    await this.requireChannelMembership(teamId, userId, channelId);

    const existing = await this.db.teamChannelMessage.findFirst({
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

    // The mentions validator is also channel-scoped so an editor can't @ users
    // who aren't in this channel.
    const validMentionIds = await this.validateMentions(teamId, channelId, input.body);
    const editedAt = new Date();

    // Defense-in-depth: teamId is added to every mutate WHERE even though
    // the `findFirst` above already verified ownership. updateMany/deleteMany
    // because `id` alone is the unique key; compound predicates on
    // .update/.delete need a compound unique.
    await this.db.$transaction([
      this.db.teamChannelMessage.updateMany({
        where: { id: messageId, teamId },
        data: { body: input.body, editedAt },
      }),
      this.db.teamChannelMention.deleteMany({
        where: { messageId, message: { teamId } },
      }),
      ...(validMentionIds.length > 0
        ? [
            this.db.teamChannelMention.createMany({
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
      const latest = await this.db.teamChannelMessage.findFirst({
        where: { channelId, threadRootId: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, body: true, mediaKind: true },
      });
      if (latest?.id === messageId) {
        await this.db.teamChannel.update({
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
    await this.requireChannelMembership(teamId, userId, channelId);
    const existing = await this.db.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, teamId },
      select: { id: true, authorUserId: true, threadRootId: true },
    });
    if (!existing) throw new NotFoundException({ error: "message not found" });

    if (!canDeleteMessage(role, existing.authorUserId, userId)) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    // Defense-in-depth: teamId in every mutate WHERE even though the findFirst
    // above already verified ownership. deleteMany/updateMany because id alone
    // is the unique key.
    let threadReplyUpdate: {
      rootMessageId: string;
      replyCount: number;
      lastReplyAt: string | null;
    } | null = null;
    if (existing.threadRootId) {
      // Reply delete: the row delete + root threadReplyCount decrement +
      // threadLastReplyAt recompute must be ATOMIC. Previously these were three
      // separate awaits, so a crash between the committed delete and the
      // decrement left the "X replies" pill drifted high with no sweeper to
      // reconcile it. One interactive tx makes them both-or-neither, mirroring
      // the in-tx increment in postThreadReply. A transient failure now rolls
      // back the delete too (the user retries) rather than stranding drift.
      const rootId = existing.threadRootId;
      threadReplyUpdate = await this.db.$transaction(async (tx) => {
        await tx.teamChannelMessage.deleteMany({
          where: { id: messageId, teamId },
        });
        const updated = await tx.teamChannelMessage.update({
          where: { id: rootId },
          data: { threadReplyCount: { decrement: 1 } },
          select: { threadReplyCount: true },
        });
        // Refresh threadLastReplyAt to the new latest sibling (or null if this
        // was the last reply).
        const latestSibling = await tx.teamChannelMessage.findFirst({
          where: { threadRootId: rootId, teamId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { createdAt: true },
        });
        await tx.teamChannelMessage.updateMany({
          where: { id: rootId, teamId },
          data: { threadLastReplyAt: latestSibling?.createdAt ?? null },
        });
        return {
          rootMessageId: rootId,
          replyCount: Math.max(0, updated.threadReplyCount),
          lastReplyAt: latestSibling?.createdAt.toISOString() ?? null,
        };
      });
    } else {
      // Top-level delete → drop the row, then refresh the channel preview to
      // whatever's now latest (sidebar UX, not load-bearing — kept best-effort
      // and out of the delete's critical path).
      await this.db.teamChannelMessage.deleteMany({
        where: { id: messageId, teamId },
      });
      const latest = await this.db.teamChannelMessage.findFirst({
        where: { channelId, teamId, threadRootId: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { body: true, mediaKind: true, createdAt: true },
      });
      await this.db.teamChannel.updateMany({
        where: { id: channelId, teamId },
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
    // Emit a thread-reply count refresh so the parent's "X replies" pill
    // in the channel feed updates on every other client (the message
    // delete frame doesn't carry the count). Idempotent — clients dedupe
    // by lastReplyAt timestamp.
    if (threadReplyUpdate) {
      await this.bus.publish({
        type: "team_channel.thread_reply_count_changed",
        teamId,
        channelId,
        rootMessageId: threadReplyUpdate.rootMessageId,
        replyCount: threadReplyUpdate.replyCount,
        lastReplyAt: threadReplyUpdate.lastReplyAt,
      });
    }
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
    await this.requireChannelMembership(teamId, userId, channelId);

    const msg = await this.db.teamChannelMessage.findFirst({
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
      await this.db.teamChannelPin.create({
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
    userId: string,
    role: Role,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    if (!canPinMessage(role)) throw new ForbiddenException({ error: "forbidden" });
    await this.requireChannelMembership(teamId, userId, channelId);

    // Tenant guard via the message — keeps unpin from teaching the caller
    // about another team's message ids.
    const msg = await this.db.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, teamId },
      select: { id: true },
    });
    if (!msg) throw new NotFoundException({ error: "message not found" });

    await this.db.teamChannelPin.deleteMany({ where: { messageId } });
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
    await this.requireChannelMembership(teamId, userId, channelId);
    const message = await this.db.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, teamId },
      select: { id: true },
    });
    if (!message) throw new NotFoundException({ error: "message not found" });

    const { emoji } = input;
    const existing = await this.db.teamChannelReaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
      select: { id: true },
    });

    if (existing) {
      await this.db.teamChannelReaction.delete({ where: { id: existing.id } });
    } else {
      try {
        await this.db.teamChannelReaction.create({
          data: { messageId, userId, emoji },
        });
      } catch (err) {
        // Raced with another of my tabs — already exists. Treat as success.
        if (!isP2002(err)) throw err;
      }
    }

    // Full snapshot per emoji — receivers don't need a delta reducer.
    // The version stamp is `Date.now()` at publish time, monotonic per
    // process. Clients discard older versions so a fast toggle pair
    // can't produce a stale-snapshot-wins race when events land out of
    // order. `createdAt` on individual rows would also work but doesn't
    // cover the "all removed" case (zero rows = no max).
    const reactions = await this.db.teamChannelReaction.findMany({
      where: { messageId, emoji },
      select: { userId: true },
    });
    const userIds = reactions.map((r) => r.userId);
    const version = Date.now();

    await this.bus.publish({
      type: "team_channel.reaction_changed",
      teamId,
      channelId,
      messageId,
      emoji,
      userIds,
      version,
    });

    return { emoji, userIds };
  }

  // ---- read receipts ----------------------------------------------------

  /**
   * Stamp the caller's read receipt for this channel to `now`. The fanout
   * rule emits `team:channel:read` to the team room so every other tab of
   * the same user clears its sidebar badge in lock-step.
   */
  async markRead(teamId: string, userId: string, channelId: string) {
    await this.requireChannelMembership(teamId, userId, channelId);
    const now = new Date();

    // Already-read short-circuit: if the receipt is already at-or-after the
    // channel's newest activity, there is nothing new to mark. Skip both the
    // write and the team-room `team:channel:read` frame so a chatty channel —
    // or a client over-calling markRead on every visible mount — doesn't fan
    // out a redundant frame to the user's whole device cohort. Cheap: one
    // already-selected receipt + the denormalized `lastMessageAt`.
    //
    // `lastMessageAt` covers TOP-LEVEL activity only — a thread reply bumps
    // `threadLastReplyAt`, NOT `lastMessageAt`. A thread reply that @-mentions
    // the user therefore leaves an unread mention the `lastMessageAt` compare
    // can't see. We MUST still write through (and publish `team:channel:read`)
    // in that case, or `onRead` never fires and the sidebar mention badge
    // stays stuck after the user reads the thread. So the short-circuit also
    // requires zero unread mentions for this user in this channel.
    const [channel, receipt] = await Promise.all([
      this.db.teamChannel.findUnique({
        where: { id: channelId },
        select: { lastMessageAt: true },
      }),
      this.db.teamChannelReadReceipt.findUnique({
        where: { userId_channelId: { userId, channelId } },
        select: { lastReadAt: true },
      }),
    ]);
    if (
      channel &&
      receipt &&
      // Strict `>`, not `>=`: a message landing in the SAME millisecond the
      // prior read receipt was stamped must NOT be treated as already-read
      // (that's the stuck-unread-dot class the keyset cursors avoid elsewhere).
      // On exact-ms equality we fall through and accept the cheap redundant
      // upsert + read frame rather than risk dropping a just-arrived message.
      receipt.lastReadAt.getTime() > channel.lastMessageAt.getTime()
    ) {
      const unreadMention = await this.db.teamChannelMention.findFirst({
        where: {
          mentionedUserId: userId,
          message: { channelId, teamId, createdAt: { gt: receipt.lastReadAt } },
        },
        select: { id: true },
      });
      if (!unreadMention) {
        return { lastReadAt: receipt.lastReadAt.toISOString() };
      }
    }

    await this.db.teamChannelReadReceipt.upsert({
      where: { userId_channelId: { userId, channelId } },
      create: { userId, channelId, lastReadAt: now },
      update: { lastReadAt: now },
    });
    await this.bus.publish({
      type: "team_channel.read",
      teamId,
      channelId,
      readByUserId: userId,
      lastReadAt: now.toISOString(),
    });
    return { lastReadAt: now.toISOString() };
  }

  // ---- threads ----------------------------------------------------------

  /**
   * List replies to a thread root, keyset-paginated ascending. `after` lets
   * the panel load more replies forward in time. Rejects when the id either
   * isn't in the team's channel (404) or is itself a reply (400) — no
   * nested threads.
   */
  async listThreadReplies(
    teamId: string,
    userId: string,
    channelId: string,
    rootMessageId: string,
    opts: { after?: string; take?: number } = {},
  ) {
    await this.requireChannelMembership(teamId, userId, channelId);
    const root = await this.requireThreadRoot(teamId, channelId, rootMessageId);
    if (root.threadRootId !== null) {
      throw new BadRequestException({
        error: "not_a_thread_root",
        detail: "Replies cannot themselves host threads.",
      });
    }
    const after = opts.after ? this.decodeCursorOrThrow(opts.after) : null;
    return queryListThreadReplies(rootMessageId, teamId, {
      take: opts.take,
      after,
    });
  }

  /**
   * Channel-scoped substring search over top-level messages. Backed by the
   * pg_trgm index — see `searchChannelMessages` in lib/team-chat/queries.ts.
   * Returns the same `ChannelMessagesPage` shape as the main feed so the
   * frontend reuses the message DTO + cursor handling.
   */
  async searchMessages(
    teamId: string,
    userId: string,
    channelId: string,
    q: string,
    opts: { before?: string; take?: number } = {},
  ) {
    const query = q.trim();
    if (query.length < 2) {
      throw new BadRequestException({
        error: "query_too_short",
        detail: "Search needs at least 2 characters.",
      });
    }
    await this.requireChannelMembership(teamId, userId, channelId);
    const before = opts.before ? this.decodeCursorOrThrow(opts.before) : null;
    return searchChannelMessages(channelId, teamId, query, {
      take: opts.take,
      before,
    });
  }

  /**
   * Workspace-wide substring search — every channel in the team that the
   * viewer can read. Hits are filtered server-side to channels the viewer
   * is a member of (plus the default channel, which is implicit-member for
   * everyone). Without that intersection, a member of one channel could
   * pull message bodies from private channels they were never in.
   */
  async searchAllMessages(
    teamId: string,
    userId: string,
    q: string,
    opts: { before?: string; take?: number } = {},
  ) {
    const query = q.trim();
    if (query.length < 2) {
      throw new BadRequestException({
        error: "query_too_short",
        detail: "Search needs at least 2 characters.",
      });
    }
    const before = opts.before ? this.decodeCursorOrThrow(opts.before) : null;
    return searchAllChannels(teamId, userId, query, { take: opts.take, before });
  }

  /**
   * Context window around an anchor message — used by search jump-to when the
   * anchor isn't in the user's currently-loaded slice. Returns the slice plus
   * `hasMoreBefore` / `hasMoreAfter` flags so the frontend can paginate
   * either direction from here.
   */
  async getMessagesAround(
    teamId: string,
    userId: string,
    channelId: string,
    messageId: string,
    opts: { take?: number } = {},
  ) {
    await this.requireChannelMembership(teamId, userId, channelId);
    const result = await listChannelMessagesAround(
      channelId,
      teamId,
      messageId,
      opts.take,
    );
    if (!result) throw new NotFoundException({ error: "message not found" });
    return result;
  }

  /**
   * Decode an opaque cursor string into `{createdAt, id}`. Throws 400 if the
   * cursor doesn't parse — clients shouldn't fabricate them, and a corrupted
   * cursor surfacing as a 500 is worse UX than a clean refuse.
   */
  private decodeCursorOrThrow(cursor: string): { createdAt: string; id: string } {
    const decoded = decodeCursor(cursor);
    if (!decoded) {
      throw new BadRequestException({ error: "invalid_cursor" });
    }
    return decoded;
  }

  /**
   * Post a reply under `rootMessageId`. Same shape as a top-level post but
   * the message row carries `threadRootId` and the root's
   * threadReplyCount / threadLastReplyAt are bumped atomically.
   *
   * Fanout: the existing `team_channel.message_created` rule already emits
   * both team-room + thread-room events when `message.threadRootId` is set;
   * threadReplyCount on the event is the post-increment value.
   */
  /** Same latency tuning as `postMessage` — see that method for rationale. */
  async postThreadReply(
    session: ApiSession,
    channelId: string,
    rootMessageId: string,
    input: PostChannelMessageInput,
  ) {
    const { teamId, userId } = session;
    const receivedAt = new Date();

    // Membership gate + root validation + mention check in parallel.
    const [, root, validMentionIds] = await Promise.all([
      this.requireChannelMembership(teamId, userId, channelId),
      this.requireThreadRoot(teamId, channelId, rootMessageId),
      this.validateMentions(teamId, channelId, input.body),
    ]);
    if (root.threadRootId !== null) {
      throw new BadRequestException({
        error: "not_a_thread_root",
        detail: "Replies cannot themselves host threads.",
      });
    }

    let created: { id: string; threadReplyCount: number };
    try {
      created = await this.db.$transaction(async (tx) => {
        const msg = await tx.teamChannelMessage.create({
          data: {
            channelId,
            teamId,
            authorUserId: userId,
            body: input.body,
            threadRootId: rootMessageId,
            createdAt: receivedAt,
            clientTempId: input.clientTempId ?? null,
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
        // Return the POST-increment count from the same atomic update so the
        // fanout publishes the true new total. Reading `root.threadReplyCount`
        // (a pre-transaction snapshot) and publishing `+1` lets two concurrent
        // replies both broadcast `N+1`; the client applies it as an ABSOLUTE
        // value, so the pill sticks at `N+1` instead of `N+2`. Mirrors the
        // decrement path in `deleteMessage`.
        const updatedRoot = await tx.teamChannelMessage.update({
          where: { id: rootMessageId },
          data: {
            threadReplyCount: { increment: 1 },
            threadLastReplyAt: receivedAt,
          },
          select: { threadReplyCount: true },
        });
        return { id: msg.id, threadReplyCount: updatedRoot.threadReplyCount };
      });
    } catch (err) {
      // Idempotent retry: the P2002 rolls the whole tx back, so the
      // threadReplyCount increment never committed — no double-bump.
      const dedup =
        input.clientTempId && isP2002(err)
          ? await this.dedupCommittedSend(teamId, userId, channelId, input.clientTempId)
          : null;
      if (dedup) return dedup;
      throw err;
    }

    const dto = buildFreshMessageDto({
      id: created.id,
      channelId,
      teamId,
      session,
      body: input.body,
      mentionedUserIds: validMentionIds,
      threadRootId: rootMessageId,
      createdAt: receivedAt,
    });

    await this.bus.publish({
      type: "team_channel.message_created",
      teamId,
      channelId,
      message: dto,
      preview: null,
      lastMessageAt: null,
      threadReplyCount: created.threadReplyCount,
      ...(input.clientTempId ? { clientTempId: input.clientTempId } : {}),
    });

    return { messageId: created.id, message: dto };
  }

  // ---- media uploads ----------------------------------------------------

  /**
   * Multipart upload — file + optional caption / clientTempId / threadRootId.
   * Same blob pipeline as customer media, no Meta hop (team chat is internal).
   * The message row carries the CDN URL plus media metadata so render is the
   * same path as a customer media message.
   */
  async uploadMedia(
    teamId: string,
    userId: string,
    channelId: string,
    args: {
      file: { bytes: Uint8Array; mimeType: string; filename: string; size: number };
      body: string;
      clientTempId: string | undefined;
      threadRootId: string | null;
    },
  ) {
    const receivedAt = new Date();
    await this.requireChannelMembership(teamId, userId, channelId);

    if (args.threadRootId) {
      const root = await this.db.teamChannelMessage.findFirst({
        where: {
          id: args.threadRootId,
          channelId,
          teamId,
          threadRootId: null,
        },
        select: { id: true },
      });
      if (!root) {
        throw new BadRequestException({ error: "invalid thread root" });
      }
    }

    const kind = kindFromMime(args.file.mimeType);
    const cap = MEDIA_SIZE_CAPS[kind];
    if (args.file.size > cap) {
      throw new BadRequestException({
        error: `file too large for ${kind}`,
        cap,
      });
    }

    const teamRow = await this.db.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });

    const saved = await blobStorage.upload({
      bytes: args.file.bytes,
      mimeType: args.file.mimeType,
      kind,
      context: {
        teamId,
        teamSlug: teamRow?.name,
        // Team chat is internal — "out" isn't meaningful. Keep "out" so the
        // dashboard name stays "<team>/out/<channel>/<file>" alongside customer
        // media for consistency.
        direction: "out",
        conversationId: channelId,
        externalId: args.clientTempId ?? `chan_${channelId}`,
        originalFilename: args.file.filename,
      },
    });

    const validMentionIds = await this.validateMentions(teamId, channelId, args.body);
    const preview = buildMessagePreview(args.body, true);
    let created: { id: string; threadReplyCount: number };
    try {
      created = await this.db.$transaction(async (tx) => {
        const msg = await tx.teamChannelMessage.create({
          data: {
            channelId,
            teamId,
            authorUserId: userId,
            body: args.body,
            mediaKind: kind,
            mediaKey: saved.key,
            mediaUrl: saved.url,
            mediaMimeType: args.file.mimeType,
            mediaCaption: args.body || null,
            mediaFilename: kind === "document" ? args.file.filename : null,
            mediaSizeBytes: saved.sizeBytes,
            createdAt: receivedAt,
            clientTempId: args.clientTempId ?? null,
            ...(args.threadRootId ? { threadRootId: args.threadRootId } : {}),
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
        // Top-level only: bump the channel summary. Replies don't surface in
        // the channel preview.
        if (!args.threadRootId) {
          await tx.teamChannel.update({
            where: { id: channelId },
            data: { lastMessageAt: receivedAt, lastMessagePreview: preview },
          });
          return { id: msg.id, threadReplyCount: 0 };
        }
        // Capture the POST-increment count from the atomic update (same fix as
        // postThreadReply) so concurrent replies don't both publish a stale
        // absolute count that sticks on the parent pill.
        const updatedRoot = await tx.teamChannelMessage.update({
          where: { id: args.threadRootId },
          data: {
            threadReplyCount: { increment: 1 },
            threadLastReplyAt: receivedAt,
          },
          select: { threadReplyCount: true },
        });
        return { id: msg.id, threadReplyCount: updatedRoot.threadReplyCount };
      });
    } catch (err) {
      // Idempotent retry: a prior media send with this clientTempId already
      // committed. The blob layer keys uploads by customId (= clientTempId), so
      // a retry's re-upload 409s and RESOLVES to the original blob instead of
      // creating an orphan — `saved.key` here IS the original's key, so there is
      // nothing to clean up (deleting it would destroy the live message's
      // media). Just return the original instead of inserting a duplicate.
      const dedup =
        args.clientTempId && isP2002(err)
          ? await this.dedupCommittedSend(teamId, userId, channelId, args.clientTempId)
          : null;
      if (dedup) return dedup;
      throw err;
    }

    const dto = await loadMessageForEmit(created.id, teamId);
    if (!dto) {
      this.logger.error("post-write media reload returned null");
      return { messageId: created.id };
    }

    await this.bus.publish({
      type: "team_channel.message_created",
      teamId,
      channelId,
      message: dto,
      preview: args.threadRootId ? null : preview,
      lastMessageAt: args.threadRootId ? null : receivedAt.toISOString(),
      threadReplyCount: created.threadReplyCount,
      ...(args.clientTempId ? { clientTempId: args.clientTempId } : {}),
    });

    return { messageId: created.id, message: dto };
  }

  /**
   * Resolve the CDN URL for a channel message's attachment, gated by team
   * scope AND channel membership. Mirrors MediaController.get for WhatsApp
   * media: a non-member (or foreign-team) caller gets a 404, and the URL is
   * `isOwnUrl`-validated before it's handed back so the open-redirect guard
   * stays symmetric. The controller 302-redirects to the returned URL; the
   * raw CDN URL is never embedded in the message DTO (M4).
   */
  async getMessageMediaKey(
    teamId: string,
    userId: string,
    channelId: string,
    messageId: string,
  ): Promise<string> {
    await this.requireChannelMembership(teamId, userId, channelId);
    const message = await this.db.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, teamId },
      select: { mediaKey: true },
    });
    // Indistinguishable from "no such message" on the missing path so we don't
    // teach the caller the validation rules. The controller streams the object
    // same-origin from this key (private bucket, no URL ever exposed).
    if (!message?.mediaKey) {
      throw new NotFoundException({ error: "not_found" });
    }
    return message.mediaKey;
  }

  // ---- helpers ----------------------------------------------------------

  /**
   * Resolve a thread root message scoped to (team, channel). 404 when it
   * doesn't exist; callers handle the "is it actually a root" check
   * separately so they can return the more specific 400 with `not_a_thread_root`.
   */
  private async requireThreadRoot(
    teamId: string,
    channelId: string,
    rootMessageId: string,
  ) {
    const root = await this.db.teamChannelMessage.findFirst({
      where: { id: rootMessageId, channelId, teamId },
      select: { id: true, threadRootId: true, threadReplyCount: true },
    });
    if (!root) throw new NotFoundException({ error: "thread not found" });
    return root;
  }

  /**
   * Throw 404 if the channel doesn't exist in this team OR the caller isn't a
   * member of it. Default channels short-circuit the membership join — every
   * team member is implicitly a member of `#general` (per `removeMember`'s
   * `default_channel_locked` rule, no one can be removed from it).
   *
   * Used to gate every per-channel read/write (list/post messages, react,
   * pin, mark-read, search, around, media, threads, listMembers). Admin-only
   * mutate ops that MUST work even for non-members (`addMembers`,
   * `removeMember`, `update`, `remove`) keep using `requireChannelInTeam`.
   *
   * Returning a 404 (not 403) on the not-a-member path is deliberate: it
   * doesn't teach a non-member that the channel exists.
   */
  private async requireChannelMembership(
    teamId: string,
    userId: string,
    channelId: string,
  ): Promise<void> {
    const channel = await this.db.teamChannel.findFirst({
      where: { id: channelId, teamId },
      select: { id: true, isDefault: true },
    });
    if (!channel) throw new NotFoundException({ error: "channel not found" });
    if (channel.isDefault) return; // Everyone is implicitly a member.
    const member = await this.db.teamChannelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: { userId: true },
    });
    if (!member) throw new NotFoundException({ error: "channel not found" });
  }

  /**
   * Parse mentions from body + intersect with the set of users who are
   * BOTH on the team AND members of this channel. Default-channel mentions
   * skip the channel-membership intersection (everyone is a member).
   *
   * Filtering by channel membership stops mention rows from being created
   * for users who can't read the message (otherwise: badge bumps with no
   * way to reach the content). Deactivated users also dropped — their
   * @handle still renders as static text via the parser; only the
   * side-effect mention rows are filtered.
   */
  private async validateMentions(
    teamId: string,
    channelId: string,
    body: string,
  ): Promise<string[]> {
    const parsed = parseMentions(body);
    const ids = Array.from(new Set(parsed.map((m) => m.userId)));
    if (ids.length === 0) return [];
    const channel = await this.db.teamChannel.findUnique({
      where: { id: channelId },
      select: { isDefault: true },
    });
    const isDefault = channel?.isDefault ?? false;
    const where: {
      teamId: string;
      id: { in: string[] };
      deactivatedAt: null;
      channelMemberships?: { some: { channelId: string } };
    } = { teamId, id: { in: ids }, deactivatedAt: null };
    if (!isDefault) {
      where.channelMemberships = { some: { channelId } };
    }
    const members = await this.db.user.findMany({
      where,
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

/**
 * Build the `TeamChannelMessageDto` for a JUST-INSERTED message without
 * re-querying. Replaces a `loadMessageForEmit` call on the send hot path —
 * one fewer DB roundtrip = recipients see the message sooner.
 *
 * Safe because every field is known at write time:
 *   - id / channelId / teamId / authorUserId / body / createdAt / threadRootId
 *     come from the inputs of the INSERT we just did.
 *   - authorName / authorAvatarUrl come from the SessionGuard's User row
 *     (already loaded for the deactivation recheck — see session.guard.ts).
 *   - reactions, pin, editedAt, threadReplyCount, threadLastReplyAt, media
 *     are empty / null by definition on a fresh row.
 *
 * Edits / reactions / pins flowing in afterward use their own emit paths
 * with the freshly-mutated row, so divergence isn't possible.
 */
function buildFreshMessageDto(args: {
  id: string;
  channelId: string;
  teamId: string;
  session: ApiSession;
  body: string;
  mentionedUserIds: string[];
  threadRootId?: string;
  createdAt: Date;
}): TeamChannelMessageDto {
  return {
    id: args.id,
    channelId: args.channelId,
    teamId: args.teamId,
    authorUserId: args.session.userId,
    authorName: args.session.name,
    authorAvatarUrl: args.session.avatarUrl,
    body: args.body,
    editedAt: null,
    threadRootId: args.threadRootId ?? null,
    threadReplyCount: 0,
    threadLastReplyAt: null,
    mentionedUserIds: args.mentionedUserIds,
    reactions: [],
    pinned: false,
    createdAt: args.createdAt.toISOString(),
  };
}
