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
  canCreateChannel,
  canDeleteChannel,
  canDeleteMessage,
  canEditMessage,
  canManageChannel,
  canPinInChannel,
  EDIT_WINDOW_MS,
} from "@ccp/shared/team-chat/permissions";
import { blobStorage } from "@/lib/blob-storage";
import { MEDIA_SIZE_CAPS, kindFromMime } from "@/lib/media-storage";
import {
  browsePublicChannels,
  buildMessagePreview,
  decodeCursor,
  getChannelById,
  getDefaultChannel,
  getPublicChannelPreview,
  listDirectMessagesForUser,
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

/**
 * Distinct emoji allowed on one message. Slack tops out around 25; this is
 * generous for any real conversation and exists only to bound a scripted
 * client (see the check in `toggleReaction`).
 */
const MAX_DISTINCT_REACTIONS_PER_MESSAGE = 40;
/** Pins per channel. `listChannelPins` is unpaginated and carries the full
 *  message DTO per pin, and it loads on every channel open — so the cap is the
 *  only thing bounding that response. Generous vs. real use (Slack's own limit
 *  is 100); the point is that a bound exists. */
const MAX_PINS_PER_CHANNEL = 100;

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
    private readonly realtime: RealtimeGateway,
  ) {}

  // ---- Channels ---------------------------------------------------------

  list(workspaceId: string, userId: string) {
    return listChannelsForUser(workspaceId, userId);
  }

  /** The viewer's 1:1 DMs, most-recently-active first. */
  listDirectMessages(workspaceId: string, userId: string) {
    return listDirectMessagesForUser(workspaceId, userId);
  }

  /** Public channels for the "Browse channels" dialog. Metadata only. */
  browse(
    workspaceId: string,
    userId: string,
    q: string | null,
    opts: { before?: string | null; take?: number },
  ) {
    return browsePublicChannels(workspaceId, userId, q, opts);
  }

  /**
   * Metadata for a public channel the viewer may not have joined — backs the
   * "join to see this channel" card. Null for private channels and DMs,
   * indistinguishable from "doesn't exist".
   */
  getPreview(workspaceId: string, channelId: string) {
    return getPublicChannelPreview(workspaceId, channelId);
  }

  /**
   * Total unread @-mentions across every channel the viewer is in. Backs the
   * app-rail badge, which needs an authoritative server-seeded count: a
   * count derived purely from socket frames has no seed on page load and no
   * way to converge after an offline gap.
   */
  async unreadMentionCount(workspaceId: string, userId: string): Promise<number> {
    const rows = await this.db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS "count"
      FROM "TeamChannelMention" mn
      INNER JOIN "TeamChannelMessage" m ON m."id" = mn."messageId"
      INNER JOIN "TeamChannel" c ON c."id" = m."channelId"
      -- Membership join is load-bearing. Without it a mention in a channel the
      -- user has since LEFT (or was removed from) keeps counting forever: the
      -- receipt can never advance past it because they can no longer open the
      -- channel, so the rail badge shows a permanent, unclearable number.
      -- isDefault short-circuits for the same reason requireChannelMembership
      -- does — everyone is implicitly a member there.
      LEFT JOIN "TeamChannelMember" mem
        ON mem."channelId" = m."channelId" AND mem."userId" = ${userId}
      LEFT JOIN "TeamChannelReadReceipt" r
        ON r."channelId" = m."channelId" AND r."userId" = ${userId}
      WHERE mn."mentionedUserId" = ${userId}
        AND m."workspaceId" = ${workspaceId}
        AND (mem."userId" IS NOT NULL OR c."isDefault" = TRUE)
        -- COALESCE(editedAt, createdAt), not createdAt alone. An edit can ADD a
        -- mention, and the message's original createdAt is by definition older
        -- than the reader's receipt by then — so a mention added by an edit was
        -- filtered out here and the reader was never told about it, permanently.
        -- The cost of using the later timestamp is that editing a message whose
        -- mention was already read re-badges it once; that clears the moment the
        -- reader opens the channel, which is the right way to be wrong.
        AND (
          r."lastReadAt" IS NULL
          OR COALESCE(m."editedAt", m."createdAt") > r."lastReadAt"
        )
    `;
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Resolve the team's default channel — the one `/team` redirects into on
   * first load. Falls back to alphabetically-first if no `isDefault` row
   * exists (defensive — see getDefaultChannel in queries.ts).
   */
  getDefault(workspaceId: string, userId: string) {
    return getDefaultChannel(workspaceId, userId);
  }

  /**
   * Fetch a single channel by id (scoped to team). Returns null when the
   * id is foreign — controller turns that into 404.
   */
  async getById(workspaceId: string, userId: string, channelId: string) {
    await this.requireChannelMembership(workspaceId, userId, channelId);
    return getChannelById(channelId, workspaceId, userId);
  }

  /**
   * Pinned messages for a channel, newest-pin first. Each entry carries
   * the full message DTO so the pins panel renders without extra fetches.
   */
  async listPins(workspaceId: string, userId: string, channelId: string) {
    await this.requireChannelMembership(workspaceId, userId, channelId);
    return listChannelPins(channelId, workspaceId);
  }

  async create(
    workspaceId: string,
    userId: string,
    role: Role,
    input: CreateChannelInput,
  ) {
    // Public channels are free for anyone to create — they're discoverable in
    // the browser and joinable by the whole team, so there's nothing to
    // govern. PRIVATE channels stay admin/manager-gated: a private channel is
    // invisible in the browser and excluded from everyone else's workspace
    // search, so an agent-created one would be an ungoverned space with no
    // discovery surface. See canCreateChannel for the full reasoning.
    const visibility = input.visibility ?? "private";
    if (!canCreateChannel(role, visibility)) {
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
    // Seeding a member list is the same privilege as addMembers, so it needs
    // the same gate. Without this, relaxing canCreateChannel for PUBLIC
    // channels handed every agent a side door: create a public channel with
    // `memberUserIds: [...everyone]` and force-join the whole team — an action
    // addMembers explicitly forbids them on any existing channel.
    const mayPickMembers = canManageChannel(role);
    const requestedMemberIds = new Set<string>(
      mayPickMembers ? (input.memberUserIds ?? []) : [],
    );
    requestedMemberIds.add(userId);
    const memberIds = [...requestedMemberIds];
    if (memberIds.length > 1) {
      const validCount = await this.db.user.count({
        where: { id: { in: memberIds }, workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null },
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
          data: { workspaceId, name, description, visibility, createdById: userId },
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
        workspaceId,
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
  async listMembers(workspaceId: string, viewerUserId: string, channelId: string) {
    await this.requireChannelMembership(workspaceId, viewerUserId, channelId);
    const rows = await this.db.teamChannelMember.findMany({
      where: { channelId },
      include: {
        user: {
          // `User.role` is gone — org-level role is `orgRole`, and the role that
          // matters here is per-WORKSPACE, on the membership row. Selecting
          // `role` off User compiled clean and would have 400'd at runtime.
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            workspaceMemberships: {
              where: { workspaceId },
              select: { role: true },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ addedAt: "desc" }, { userId: "asc" }],
    });
    return rows.map((r) => ({
      channelId: r.channelId,
      userId: r.userId,
      name: r.user.name,
      email: r.user.email,
      role: r.user.workspaceMemberships[0]?.role ?? "agent",
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
    workspaceId: string,
    actorUserId: string,
    role: Role,
    channelId: string,
    userIds: string[],
  ): Promise<{ added: string[] }> {
    if (!canManageChannel(role)) throw new ForbiddenException({ error: "forbidden" });
    // A DM is 1:1 by construction — nobody, admin included, may add a third
    // party to someone else's private conversation.
    this.assertNotDm(await this.requireChannelInTeam(workspaceId, channelId));

    const ids = [...new Set(userIds)];
    if (ids.length === 0) return { added: [] };

    const validUsers = await this.db.user.findMany({
      where: { id: { in: ids }, workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null },
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
        workspaceId,
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
    workspaceId: string,
    actorUserId: string,
    role: Role,
    channelId: string,
    targetUserId: string,
  ): Promise<void> {
    const channel = await this.requireChannelInTeam(workspaceId, channelId);
    // You don't "leave" a DM — it's the conversation itself, and leaving
    // would strand the other party in a one-sided room. Hiding/archiving a
    // DM is a separate feature if anyone asks for it.
    this.assertNotDm(channel);

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
      workspaceId,
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

  private async requireChannelInTeam(workspaceId: string, channelId: string) {
    const channel = await this.db.teamChannel.findFirst({
      where: { id: channelId, workspaceId },
      select: { id: true, isDefault: true, kind: true, visibility: true },
    });
    if (!channel) throw new NotFoundException({ error: "channel_not_found" });
    return channel;
  }

  /**
   * Reject channel-administration operations targeting a DM.
   *
   * LOAD-BEARING. Without this, `POST /api/workspace/channels/:dmId/members` would
   * let an admin inject a third party into two colleagues' private 1:1 — the
   * existing members_changed fanout would dutifully wire the new member into
   * the room and hand them the full history. It also breaks the 1:1 invariant
   * that `dmKey` exists to guarantee.
   *
   * 404 rather than 400/403 so the response is indistinguishable from "no such
   * channel", matching the non-disclosure posture used everywhere else here.
   */
  private assertNotDm(channel: { kind: string }): void {
    if (channel.kind === "dm") {
      throw new NotFoundException({ error: "channel_not_found" });
    }
  }

  async update(
    workspaceId: string,
    role: Role,
    channelId: string,
    input: UpdateChannelInput,
  ) {
    if (!canManageChannel(role)) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    const existing = await this.db.teamChannel.findFirst({
      where: { id: channelId, workspaceId },
    });
    if (!existing) throw new NotFoundException({ error: "channel_not_found" });
    // A DM has no name, description, or visibility to edit.
    this.assertNotDm(existing);

    const data: {
      name?: string;
      description?: string | null;
      visibility?: "public" | "private";
    } = {};

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
    if (input.visibility !== undefined && input.visibility !== existing.visibility) {
      // #general must stay public — it's the landing channel every team
      // member is implicitly in, and making it private would lock newcomers
      // out of the one place they're guaranteed to be able to read.
      if (existing.isDefault) {
        throw new ConflictException({
          error: "default_channel_locked",
          detail: "The default channel must stay public.",
        });
      }
      // Note: public → private deliberately does NOT purge existing members.
      // People already in the channel stay in it; visibility governs who may
      // JOIN from here on, not who is retroactively evicted.
      data.visibility = input.visibility;
    }

    if (Object.keys(data).length === 0) {
      return mapChannel(existing);
    }

    let updated;
    try {
      // updateMany (not update) so `workspaceId` can appear in the WHERE — `id` is
      // the only unique, and §18 wants workspaceId in every query's where clause.
      const res = await this.db.teamChannel.updateMany({
        where: { id: channelId, workspaceId },
        data,
      });
      if (res.count === 0) throw new NotFoundException({ error: "channel_not_found" });
      updated = await this.db.teamChannel.findFirstOrThrow({
        where: { id: channelId, workspaceId },
      });
    } catch (err) {
      if (isP2002(err)) throw new ConflictException({ error: "name_taken" });
      throw err;
    }

    await this.bus.publish({
      type: "team.catalog_changed",
      workspaceId,
      scope: "team-channels",
    });
    return mapChannel(updated);
  }

  async remove(workspaceId: string, role: Role, channelId: string): Promise<void> {
    if (!canDeleteChannel(role)) throw new ForbiddenException({ error: "forbidden" });

    const existing = await this.db.teamChannel.findFirst({
      where: { id: channelId, workspaceId },
    });
    if (!existing) throw new NotFoundException({ error: "channel_not_found" });
    // A DM isn't an administrable channel — deleting one would destroy the
    // other party's history without their say.
    this.assertNotDm(existing);
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
      workspaceId,
      scope: "team-channels",
    });
  }

  // ---- Direct messages --------------------------------------------------

  /**
   * Open the 1:1 DM between the actor and `targetUserId`, creating it on
   * first use. Idempotent: opening the same DM again — from either side, any
   * number of times — always resolves to the same channel row.
   *
   * Self-DM is allowed and becomes the "notes to self" surface. It needs no
   * special handling: dmKey is "u:u", there's one member row, and
   * requireChannelMembership / emitChannelScoped / member counts all tolerate
   * a one-member channel unchanged.
   */
  async createOrGetDm(workspaceId: string, actorUserId: string, targetUserId: string) {
    // TENANT ISOLATION: the workspaceId predicate here is load-bearing. Without
    // it, a client-supplied userId from ANOTHER team would create a DM row
    // inside this team carrying a foreign user's membership — and that user's
    // DM list (which filters on membership alone) would surface it.
    // `deactivatedAt: null` matches the filter addMembers already applies:
    // you can keep reading an existing DM with someone who was deactivated,
    // but you can't start a new one.
    const target = await this.db.user.findFirst({
      where: { id: targetUserId, workspaceMemberships: { some: { workspaceId } }, deactivatedAt: null },
      select: { id: true },
    });
    if (!target) {
      throw new BadRequestException({
        error: "invalid_member",
        detail: "That person isn't an active member of this team.",
      });
    }

    // Canonical participant key, ALWAYS derived server-side from the session
    // user. Never accept this from the client or a caller could claim a DM
    // between two other people.
    const dmKey = [actorUserId, target.id].sort().join(":");
    const memberIds = [...new Set([actorUserId, target.id])];

    const existing = await this.db.teamChannel.findUnique({
      where: { workspaceId_dmKey: { workspaceId, dmKey } },
      include: { _count: { select: { members: true } } },
    });
    if (existing) {
      // REPAIR MISSING MEMBERSHIP before handing the channel back.
      //
      // Removing someone from a workspace deletes every `TeamChannelMember`
      // row they hold, DMs included (remove-member.ts). Re-adding them creates
      // only the `WorkspaceMember` row — so this used to return the channel
      // DTO while `requireChannelMembership` 404'd every read of it, and the
      // `@@unique([workspaceId, dmKey])` guaranteed no replacement could ever
      // be created. The DM was unreachable for BOTH people, permanently, with
      // no route back from the UI.
      //
      // `createMany` + `skipDuplicates` is a no-op in the common case (both
      // rows present), so the healthy path pays one cheap upsert.
      await this.db.teamChannelMember.createMany({
        data: memberIds.map((userId) => ({ channelId: existing.id, userId })),
        skipDuplicates: true,
      });
      const members = await this.db.teamChannelMember.count({
        where: { channelId: existing.id },
      });
      return mapChannel(existing, members);
    }

    try {
      const created = await this.db.$transaction(async (tx) => {
        const channel = await tx.teamChannel.create({
          data: {
            workspaceId,
            name: null,
            kind: "dm",
            // Belt and braces — a DM is private by definition and must never
            // appear in the public channel browser.
            visibility: "private",
            isDefault: false,
            dmKey,
            createdById: actorUserId,
          },
        });
        await tx.teamChannelMember.createMany({
          data: memberIds.map((id) => ({
            channelId: channel.id,
            userId: id,
            addedById: actorUserId,
          })),
          skipDuplicates: true,
        });
        return channel;
      });

      // Published ONLY on the create branch. Re-opening an existing DM must
      // not re-emit, or every open would re-surface it in the peer's sidebar.
      await this.bus.publish({
        type: "team_channel.dm_created",
        workspaceId,
        channelId: created.id,
        memberUserIds: memberIds,
        createdByUserId: actorUserId,
      });
      return mapChannel(created, memberIds.length);
    } catch (err) {
      // Lost the race against a concurrent open (the other party clicked at
      // the same moment). The unique on (workspaceId, dmKey) is what makes this
      // safe — re-read and return the winner rather than creating a twin.
      if (isP2002(err)) {
        const raced = await this.db.teamChannel.findUnique({
          where: { workspaceId_dmKey: { workspaceId, dmKey } },
          include: { _count: { select: { members: true } } },
        });
        if (raced) return mapChannel(raced, raced._count.members);
      }
      throw err;
    }
  }

  /**
   * Self-serve join of a PUBLIC channel. Idempotent — joining twice is a
   * no-op success, so a double-click can't 500.
   *
   * Private channels 404 rather than 403: telling a non-member "you're not
   * allowed into #leadership-comp" discloses that it exists, which is exactly
   * what requireChannelMembership's 404-not-403 posture avoids elsewhere.
   */
  async joinPublicChannel(
    workspaceId: string,
    userId: string,
    channelId: string,
  ): Promise<{ joined: boolean }> {
    const channel = await this.requireChannelInTeam(workspaceId, channelId);
    this.assertNotDm(channel);
    if (channel.visibility === "private") {
      throw new NotFoundException({ error: "channel_not_found" });
    }

    const result = await this.db.teamChannelMember.createMany({
      data: [{ channelId, userId, addedById: userId }],
      skipDuplicates: true,
    });
    const joined = result.count > 0;

    if (joined) {
      // Reuses the EXISTING members_changed event: same fanout rule, same
      // client handler, no new realtime code for the join path.
      await this.bus.publish({
        type: "team_channel.members_changed",
        workspaceId,
        channelId,
        action: "added",
        userIds: [userId],
        changedById: userId,
      });
    }
    return { joined };
  }

  // ---- Messages ---------------------------------------------------------

  async listMessages(
    workspaceId: string,
    userId: string,
    channelId: string,
    opts: { after?: string; before?: string; take?: number },
  ) {
    await this.requireChannelMembership(workspaceId, userId, channelId);

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
        throw new BadRequestException({ error: "invalid_after" });
      }
      // Now returns { items, nextCursor } symmetrically with the
      // ?before= path — client doesn't have to infer pagination state
      // from `items.length >= PAGE_SIZE` anymore.
      return listChannelMessagesAfter(channelId, workspaceId, after, opts.take);
    }

    const before = opts.before ? decodeCursor(opts.before) : null;
    if (opts.before && !before) {
      throw new BadRequestException({ error: "invalid_cursor" });
    }
    return listChannelMessages(channelId, workspaceId, {
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
    workspaceId: string,
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
    const dto = await loadMessageForEmit(existing.id, workspaceId);
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
      workspaceId,
      channelId,
      message: dto,
      preview: isReply
        ? null
        : buildMessagePreview(existing.body, existing.mediaKind !== null),
      lastMessageAt: isReply ? null : existing.createdAt.toISOString(),
      threadReplyCount,
      clientTempId,
      redelivery: true,
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
    const { workspaceId, userId } = session;
    const receivedAt = new Date();

    const [, , validMentionIds] = await Promise.all([
      this.requireChannelMembership(workspaceId, userId, channelId),
      this.assertChannelWritable(workspaceId, userId, channelId),
      this.validateMentions(workspaceId, channelId, input.body),
    ]);

    const preview = buildMessagePreview(input.body, false);
    let created: { id: string };
    try {
      created = await this.db.$transaction(async (tx) => {
        const msg = await tx.teamChannelMessage.create({
          data: {
            channelId,
            workspaceId,
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
          ? await this.dedupCommittedSend(workspaceId, userId, channelId, input.clientTempId)
          : null;
      if (dedup) return dedup;
      throw err;
    }

    const dto = buildFreshMessageDto({
      id: created.id,
      channelId,
      workspaceId,
      session,
      body: input.body,
      mentionedUserIds: validMentionIds,
      createdAt: receivedAt,
    });

    await this.bus.publish({
      type: "team_channel.message_created",
      workspaceId,
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
    workspaceId: string,
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
    await this.requireChannelMembership(workspaceId, userId, channelId);

    const existing = await this.db.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, workspaceId },
      select: {
        id: true,
        authorUserId: true,
        createdAt: true,
        threadRootId: true,
        mediaKind: true,
      },
    });
    if (!existing) throw new NotFoundException({ error: "message_not_found" });

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
    const validMentionIds = await this.validateMentions(workspaceId, channelId, input.body);
    // Who this edit newly @-mentions. Read BEFORE the transaction replaces the
    // rows: an edit is the one way to be mentioned without a new message, and
    // it used to notify nobody. Only the ADDED ids are alerted — re-badging
    // everyone on a typo fix would resurrect mentions people already cleared.
    const priorMentions = await this.db.teamChannelMention.findMany({
      where: { messageId },
      select: { mentionedUserId: true },
    });
    const priorMentionIds = new Set(priorMentions.map((m) => m.mentionedUserId));
    const newlyMentionedUserIds = validMentionIds.filter(
      (uid) => !priorMentionIds.has(uid) && uid !== userId,
    );
    const editedAt = new Date();

    // Defense-in-depth: workspaceId is added to every mutate WHERE even though
    // the `findFirst` above already verified ownership. updateMany/deleteMany
    // because `id` alone is the unique key; compound predicates on
    // .update/.delete need a compound unique.
    await this.db.$transaction([
      this.db.teamChannelMessage.updateMany({
        where: { id: messageId, workspaceId },
        data: { body: input.body, editedAt },
      }),
      this.db.teamChannelMention.deleteMany({
        where: { messageId, message: { workspaceId } },
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
      workspaceId,
      channelId,
      messageId,
      body: input.body,
      editedAt: editedAt.toISOString(),
      authorUserId: existing.authorUserId,
      newlyMentionedUserIds,
    });
    const dto = await loadMessageForEmit(messageId, workspaceId);
    return { message: dto };
  }

  async deleteMessage(
    workspaceId: string,
    userId: string,
    role: Role,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.requireChannelMembership(workspaceId, userId, channelId);
    const existing = await this.db.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, workspaceId },
      select: { id: true, authorUserId: true, threadRootId: true },
    });
    if (!existing) throw new NotFoundException({ error: "message_not_found" });

    if (!canDeleteMessage(role, existing.authorUserId, userId)) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    // Defense-in-depth: workspaceId in every mutate WHERE even though the findFirst
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
        const del = await tx.teamChannelMessage.deleteMany({
          where: { id: messageId, workspaceId },
        });
        // Lost a concurrent-delete race: we blocked on the row lock, then the
        // committing tx had already removed it, so deleteMany matched 0. Bail
        // (rolls the tx back cleanly) BEFORE the decrement — otherwise the root
        // counter would be double-decremented and drift negative with no sweeper.
        if (del.count === 0) {
          throw new NotFoundException({ error: "message_not_found" });
        }
        const updated = await tx.teamChannelMessage.update({
          where: { id: rootId },
          data: { threadReplyCount: { decrement: 1 } },
          select: { threadReplyCount: true },
        });
        // Refresh threadLastReplyAt to the new latest sibling (or null if this
        // was the last reply).
        const latestSibling = await tx.teamChannelMessage.findFirst({
          where: { threadRootId: rootId, workspaceId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { createdAt: true },
        });
        await tx.teamChannelMessage.updateMany({
          where: { id: rootId, workspaceId },
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
        where: { id: messageId, workspaceId },
      });
      const [latest, channelRow] = await Promise.all([
        this.db.teamChannelMessage.findFirst({
          where: { channelId, workspaceId, threadRootId: null },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { body: true, mediaKind: true, createdAt: true },
        }),
        this.db.teamChannel.findFirst({
          where: { id: channelId, workspaceId },
          select: { createdAt: true },
        }),
      ]);
      await this.db.teamChannel.updateMany({
        where: { id: channelId, workspaceId },
        data: latest
          ? {
              lastMessageAt: latest.createdAt,
              lastMessagePreview: buildMessagePreview(latest.body, !!latest.mediaKind),
            }
          // Deleting the LAST message empties the channel, so the timestamp has
          // to roll back with the preview. `lastMessageAt === createdAt` is the
          // schema's "no messages yet" sentinel (see the unreadForMe fallback in
          // lib/team-chat/queries.ts); leaving it on the deleted row's time kept
          // that comparison true, so a member who had never opened the channel
          // saw it badged unread forever over a blank preview with nothing in it.
          : {
              lastMessagePreview: "",
              ...(channelRow ? { lastMessageAt: channelRow.createdAt } : {}),
            },
      });
    }

    await this.bus.publish({
      type: "team_channel.message_deleted",
      workspaceId,
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
        workspaceId,
        channelId,
        rootMessageId: threadReplyUpdate.rootMessageId,
        replyCount: threadReplyUpdate.replyCount,
        lastReplyAt: threadReplyUpdate.lastReplyAt,
      });
    }
  }

  // ---- Pins -------------------------------------------------------------

  async pinMessage(
    workspaceId: string,
    userId: string,
    role: Role,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.requireChannelMembership(workspaceId, userId, channelId);
    // Role-gate pinning in channels only. In a DM both participants may pin:
    // an admin who isn't in the DM can't reach it anyway, and a non-admin
    // shouldn't need permission to pin something in their own conversation.
    const channel = await this.requireChannelInTeam(workspaceId, channelId);
    if (!canPinInChannel(role, channel.kind)) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    const msg = await this.db.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, workspaceId },
      select: { id: true, threadRootId: true },
    });
    if (!msg) throw new NotFoundException({ error: "message_not_found" });
    if (msg.threadRootId !== null) {
      throw new BadRequestException({
        error: "thread_reply_unpinnable",
        detail: "Only top-level messages can be pinned.",
      });
    }

    // Cap the catalog. Every other list in the product has one (stages 30,
    // contact fields 50, knowledge docs 50, distinct reactions 40); pins did
    // not, and `listChannelPins` is unpaginated and carries the FULL message
    // DTO for each pin — it is fetched on every channel open, by BOTH parties
    // in a DM where either may pin without a role gate. A scripted loop at the
    // rate limit turned that response into tens of MB.
    const pinCount = await this.db.teamChannelPin.count({ where: { channelId } });
    if (pinCount >= MAX_PINS_PER_CHANNEL) {
      throw new BadRequestException({
        error: "pin_limit_reached",
        detail: `This channel has reached its limit of ${MAX_PINS_PER_CHANNEL} pinned messages. Unpin one to make room.`,
      });
    }

    let pinnedAt = new Date();
    try {
      const pin = await this.db.teamChannelPin.create({
        data: { channelId, messageId, pinnedById: userId },
        select: { pinnedAt: true },
      });
      pinnedAt = pin.pinnedAt;
    } catch (err) {
      if (!isP2002(err)) throw err;
      // Already pinned — idempotent success. Re-read so the emitted metadata
      // describes the ORIGINAL pin, not this no-op retry.
      const existing = await this.db.teamChannelPin.findUnique({
        where: { messageId },
        select: { pinnedAt: true },
      });
      if (existing) pinnedAt = existing.pinnedAt;
    }
    const pinner = await this.db.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    await this.bus.publish({
      type: "team_channel.pin_changed",
      workspaceId,
      channelId,
      messageId,
      pinned: true,
      pinnedAt: pinnedAt.toISOString(),
      pinnedById: userId,
      pinnedByName: pinner?.name ?? null,
    });
  }

  async unpinMessage(
    workspaceId: string,
    userId: string,
    role: Role,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await this.requireChannelMembership(workspaceId, userId, channelId);
    const channel = await this.requireChannelInTeam(workspaceId, channelId);
    if (!canPinInChannel(role, channel.kind)) {
      throw new ForbiddenException({ error: "forbidden" });
    }

    // Tenant guard via the message — keeps unpin from teaching the caller
    // about another team's message ids.
    const msg = await this.db.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, workspaceId },
      select: { id: true },
    });
    if (!msg) throw new NotFoundException({ error: "message_not_found" });

    await this.db.teamChannelPin.deleteMany({ where: { messageId } });
    await this.bus.publish({
      type: "team_channel.pin_changed",
      workspaceId,
      channelId,
      messageId,
      pinned: false,
      pinnedAt: null,
      pinnedById: null,
      pinnedByName: null,
    });
  }

  // ---- Reactions --------------------------------------------------------

  async toggleReaction(
    workspaceId: string,
    userId: string,
    channelId: string,
    messageId: string,
    input: ToggleReactionInput,
  ): Promise<{ emoji: string; userIds: string[] }> {
    await this.requireChannelMembership(workspaceId, userId, channelId);
    const message = await this.db.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, workspaceId },
      select: { id: true },
    });
    if (!message) throw new NotFoundException({ error: "message_not_found" });

    const { emoji } = input;

    // Serialize concurrent toggles on the same message via a row lock so the
    // find/create-or-delete, the snapshot read, and the version stamp are all
    // ordered against each other. Without this, two toggles in the same tick
    // interleave read-then-publish: the earlier-committing one can ship the
    // OLDER snapshot under the HIGHER `Date.now()` (stamped at publish time),
    // so a client applying authoritative frames drops a reaction from live view
    // until a refetch. Stamping the version INSIDE the locked section (below)
    // makes it monotonic with the snapshot it describes. The lock also turns
    // the same-user un-react double-fire into a no-op instead of a P2025, the
    // mirror of the create branch treating a P2002 as success. Cheap —
    // reactions are low-rate.
    const { userIds, version } = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "TeamChannelMessage" WHERE id = ${messageId} FOR UPDATE`;

      const existing = await tx.teamChannelReaction.findUnique({
        where: { messageId_userId_emoji: { messageId, userId, emoji } },
        select: { id: true },
      });

      if (existing) {
        // deleteMany (not delete) so a lost un-react race is a 0-row no-op
        // rather than a P2025.
        await tx.teamChannelReaction.deleteMany({ where: { id: existing.id } });
      } else {
        // Ceiling on DISTINCT emoji per message. Adding one is unbounded work
        // for everyone else — each new value is a permanent chip rendered under
        // the message for every member and a frame to the whole channel room —
        // so a scripted client could bury a message under hundreds of them at
        // the 300/min rate limit. Well above any real conversation; only a
        // NEW emoji is gated, so joining an existing reaction always works.
        const distinct = await tx.teamChannelReaction.groupBy({
          by: ["emoji"],
          where: { messageId },
        });
        if (distinct.length >= MAX_DISTINCT_REACTIONS_PER_MESSAGE) {
          throw new BadRequestException({ error: "too_many_reactions" });
        }
        try {
          await tx.teamChannelReaction.create({
            data: { messageId, userId, emoji },
          });
        } catch (err) {
          // Raced with another of my tabs — already exists. Treat as success.
          if (!isP2002(err)) throw err;
        }
      }

      // Full snapshot per emoji — receivers don't need a delta reducer.
      // `createdAt` on individual rows would also work but doesn't cover the
      // "all removed" case (zero rows = no max), hence the process-clock stamp.
      const rows = await tx.teamChannelReaction.findMany({
        where: { messageId, emoji },
        select: { userId: true },
      });
      return { userIds: rows.map((r) => r.userId), version: Date.now() };
    });

    await this.bus.publish({
      type: "team_channel.reaction_changed",
      workspaceId,
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
  async markRead(workspaceId: string, userId: string, channelId: string) {
    await this.requireChannelMembership(workspaceId, userId, channelId);
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
      // COALESCE(editedAt, createdAt), NOT createdAt — the two counters that
      // PRODUCE this badge (the rail count above and `queries.ts`'s per-channel
      // count) both do, precisely because an @mention added by an EDIT has an
      // old createdAt. Probing on createdAt alone made the clearing path
      // disagree with the counting paths: an edit-added mention is never found
      // here, so markRead returns early without stamping the receipt, and the
      // badge sticks forever (editing doesn't bump `lastMessageAt`, so the
      // short-circuit stays entered) until an unrelated message lands.
      const [unreadMention] = await this.db.$queryRaw<{ id: string }[]>`
        SELECT mn.id
        FROM "TeamChannelMention" mn
        JOIN "TeamChannelMessage" m ON m.id = mn."messageId"
        WHERE mn."mentionedUserId" = ${userId}
          AND m."channelId" = ${channelId}
          AND m."workspaceId" = ${workspaceId}
          AND COALESCE(m."editedAt", m."createdAt") > ${receipt.lastReadAt}
        LIMIT 1
      `;
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
      workspaceId,
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
    workspaceId: string,
    userId: string,
    channelId: string,
    rootMessageId: string,
    opts: { after?: string; take?: number } = {},
  ) {
    await this.requireChannelMembership(workspaceId, userId, channelId);
    const root = await this.requireThreadRoot(workspaceId, channelId, rootMessageId);
    if (root.threadRootId !== null) {
      throw new BadRequestException({
        error: "not_a_thread_root",
        detail: "Replies cannot themselves host threads.",
      });
    }
    const after = opts.after ? this.decodeCursorOrThrow(opts.after) : null;
    return queryListThreadReplies(rootMessageId, workspaceId, {
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
    workspaceId: string,
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
    await this.requireChannelMembership(workspaceId, userId, channelId);
    const before = opts.before ? this.decodeCursorOrThrow(opts.before) : null;
    return searchChannelMessages(channelId, workspaceId, query, {
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
    workspaceId: string,
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
    return searchAllChannels(workspaceId, userId, query, { take: opts.take, before });
  }

  /**
   * Context window around an anchor message — used by search jump-to when the
   * anchor isn't in the user's currently-loaded slice. Returns the slice plus
   * `hasMoreBefore` / `hasMoreAfter` flags so the frontend can paginate
   * either direction from here.
   */
  async getMessagesAround(
    workspaceId: string,
    userId: string,
    channelId: string,
    messageId: string,
    opts: { take?: number } = {},
  ) {
    await this.requireChannelMembership(workspaceId, userId, channelId);
    const result = await listChannelMessagesAround(
      channelId,
      workspaceId,
      messageId,
      opts.take,
    );
    if (!result) throw new NotFoundException({ error: "message_not_found" });
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
    const { workspaceId, userId } = session;
    const receivedAt = new Date();

    // Membership gate + root validation + mention check in parallel.
    const [, , root, validMentionIds] = await Promise.all([
      this.requireChannelMembership(workspaceId, userId, channelId),
      this.assertChannelWritable(workspaceId, userId, channelId),
      this.requireThreadRoot(workspaceId, channelId, rootMessageId),
      this.validateMentions(workspaceId, channelId, input.body),
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
            workspaceId,
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
          ? await this.dedupCommittedSend(workspaceId, userId, channelId, input.clientTempId)
          : null;
      if (dedup) return dedup;
      throw err;
    }

    const dto = buildFreshMessageDto({
      id: created.id,
      channelId,
      workspaceId,
      session,
      body: input.body,
      mentionedUserIds: validMentionIds,
      threadRootId: rootMessageId,
      createdAt: receivedAt,
    });

    await this.bus.publish({
      type: "team_channel.message_created",
      workspaceId,
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
    workspaceId: string,
    userId: string,
    channelId: string,
    args: {
      file: { bytes: Uint8Array; mimeType: string; filename: string; size: number };
      body: string;
      clientTempId: string | undefined;
      threadRootId: string | null;
    },
  ) {
    await this.requireChannelMembership(workspaceId, userId, channelId);
    await this.assertChannelWritable(workspaceId, userId, channelId);

    if (args.threadRootId) {
      const root = await this.db.teamChannelMessage.findFirst({
        where: {
          id: args.threadRootId,
          channelId,
          workspaceId,
          threadRootId: null,
        },
        select: { id: true },
      });
      if (!root) {
        throw new BadRequestException({ error: "invalid_thread_root" });
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

    const teamRow = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { name: true },
    });

    const saved = await blobStorage.upload({
      bytes: args.file.bytes,
      mimeType: args.file.mimeType,
      kind,
      context: {
        workspaceId,
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

    const validMentionIds = await this.validateMentions(workspaceId, channelId, args.body);
    const preview = buildMessagePreview(args.body, true);
    // Stamp AFTER the (potentially slow) blob upload so createdAt / lastMessageAt
    // reflect commit time, not upload start. A method-entry stamp backdates the
    // message and moves lastMessageAt backwards past activity that happened during
    // a large upload (breaking unread + the timestamp-delta backfill).
    const receivedAt = new Date();
    let created: { id: string; threadReplyCount: number };
    try {
      created = await this.db.$transaction(async (tx) => {
        const msg = await tx.teamChannelMessage.create({
          data: {
            channelId,
            workspaceId,
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
          // Same reason postMessage does this (see its comment): the upload
          // just moved `lastMessageAt`, and `unreadForMe` compares that to the
          // reader's receipt — so without advancing the AUTHOR's receipt, the
          // sender's own sidebar badged the channel unread for a file they
          // themselves posted. The client can't compensate: it deliberately
          // skips markRead for its own sends.
          await tx.teamChannelReadReceipt.upsert({
            where: { userId_channelId: { userId, channelId } },
            create: { userId, channelId, lastReadAt: receivedAt },
            update: { lastReadAt: receivedAt },
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
          ? await this.dedupCommittedSend(workspaceId, userId, channelId, args.clientTempId)
          : null;
      if (dedup) return dedup;
      throw err;
    }

    const dto = await loadMessageForEmit(created.id, workspaceId);
    if (!dto) {
      this.logger.error("post-write media reload returned null");
      return { messageId: created.id };
    }

    await this.bus.publish({
      type: "team_channel.message_created",
      workspaceId,
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
    workspaceId: string,
    userId: string,
    channelId: string,
    messageId: string,
  ): Promise<string> {
    await this.requireChannelMembership(workspaceId, userId, channelId);
    const message = await this.db.teamChannelMessage.findFirst({
      where: { id: messageId, channelId, workspaceId },
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
    workspaceId: string,
    channelId: string,
    rootMessageId: string,
  ) {
    const root = await this.db.teamChannelMessage.findFirst({
      where: { id: rootMessageId, channelId, workspaceId },
      select: { id: true, threadRootId: true, threadReplyCount: true },
    });
    if (!root) throw new NotFoundException({ error: "thread_not_found" });
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
    workspaceId: string,
    userId: string,
    channelId: string,
  ): Promise<void> {
    const channel = await this.db.teamChannel.findFirst({
      where: { id: channelId, workspaceId },
      select: { id: true, isDefault: true },
    });
    if (!channel) throw new NotFoundException({ error: "channel_not_found" });
    if (channel.isDefault) return; // Everyone is implicitly a member.
    const member = await this.db.teamChannelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: { userId: true },
    });
    if (!member) throw new NotFoundException({ error: "channel_not_found" });
  }

  /**
   * A DM whose other participant has left the team is READ-ONLY.
   *
   * `DirectMessagePeerDto.deactivated` has documented this since it was
   * introduced ("history stays readable, composer disabled") but nothing
   * enforced it on either side, so an agent could type a handover note into a
   * conversation whose only other reader no longer has an account. The UI now
   * swaps the composer for an explanation; this is the rule behind it, so the
   * `/v1`-style direct-POST path can't bypass the affordance.
   *
   * Reads are deliberately untouched — the whole point is that the history
   * stays available. Only the three send paths call this.
   *
   * A self-DM ("notes to self") has no other member, so `peer` is null and the
   * check passes — that conversation must keep working.
   */
  private async assertChannelWritable(
    workspaceId: string,
    userId: string,
    channelId: string,
  ): Promise<void> {
    const channel = await this.db.teamChannel.findFirst({
      where: { id: channelId, workspaceId },
      select: { kind: true },
    });
    if (channel?.kind !== "dm") return;
    const peer = await this.db.teamChannelMember.findFirst({
      where: { channelId, userId: { not: userId } },
      select: { user: { select: { name: true, deactivatedAt: true } } },
    });
    if (peer?.user.deactivatedAt) {
      throw new UnprocessableEntityException({
        error: "dm_peer_deactivated",
        detail: `${peer.user.name ?? "That teammate"} no longer has an account on this team.`,
      });
    }
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
    workspaceId: string,
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
    // Users are ORG-scoped since the restructure — "on the team" means a
    // WorkspaceMember row, not a User.workspaceId column. The old filter kept
    // the dropped column and turned EVERY mention-carrying send into a 400
    // (PrismaClientValidationError → invalid_request) until 2026-07-26.
    const where: {
      id: { in: string[] };
      deactivatedAt: null;
      workspaceMemberships: { some: { workspaceId: string } };
      channelMemberships?: { some: { channelId: string } };
    } = {
      id: { in: ids },
      deactivatedAt: null,
      workspaceMemberships: { some: { workspaceId } },
    };
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
 *   - id / channelId / workspaceId / authorUserId / body / createdAt / threadRootId
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
  workspaceId: string;
  session: ApiSession;
  body: string;
  mentionedUserIds: string[];
  threadRootId?: string;
  createdAt: Date;
}): TeamChannelMessageDto {
  return {
    id: args.id,
    channelId: args.channelId,
    workspaceId: args.workspaceId,
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
