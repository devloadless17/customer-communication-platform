import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  canCreateChannel,
  canDeleteChannel,
  canManageChannel,
} from "@ccp/shared/team-chat/permissions";
import {
  browsePublicChannels,
  getChannelById,
  getDefaultChannel,
  getPublicChannelPreview,
  listDirectMessagesForUser,
  listChannelsForUser,
  mapChannel,
} from "@/lib/team-chat/queries";
import {
  DEFAULT_CHANNEL_NAME,
  isValidChannelName,
  normalizeChannelName,
} from "@ccp/shared/team-chat/types";
import type { Role } from "@ccp/shared/types";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import type {
  CreateChannelInput,
  UpdateChannelInput,
} from "./channels.schemas";
import {
  assertNotDm,
  isP2002,
  requireChannelInTeam,
  requireChannelMembership,
} from "./channel-guards";

/**
 * Team-chat CHANNEL lifecycle, membership and DMs — what remains of the old
 * 2,083-line ChannelsService after the 2026-07-31 split (messages →
 * ChannelMessagesService; pins/reactions/read receipts →
 * ChannelEngagementService). Access rules shared via channel-guards.ts.
 */
@Injectable()
export class ChannelsService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

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
    await requireChannelMembership(this.db, workspaceId, userId, channelId);
    return getChannelById(channelId, workspaceId, userId);
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
    await requireChannelMembership(this.db, workspaceId, viewerUserId, channelId);
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
    assertNotDm(await requireChannelInTeam(this.db, workspaceId, channelId));

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
    const channel = await requireChannelInTeam(this.db, workspaceId, channelId);
    // You don't "leave" a DM — it's the conversation itself, and leaving
    // would strand the other party in a one-sided room. Hiding/archiving a
    // DM is a separate feature if anyone asks for it.
    assertNotDm(channel);

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
    assertNotDm(existing);

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
    assertNotDm(existing);
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
    const channel = await requireChannelInTeam(this.db, workspaceId, channelId);
    assertNotDm(channel);
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

}
