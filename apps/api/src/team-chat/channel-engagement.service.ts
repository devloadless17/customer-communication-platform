import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import {
  canPinInChannel,
} from "@ccp/shared/team-chat/permissions";
import {
  listChannelPins,
} from "@/lib/team-chat/queries";
import type { Role } from "@ccp/shared/types";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import type {
  ToggleReactionInput,
} from "./channels.schemas";
import {
  isP2002,
  requireChannelInTeam,
  requireChannelMembership,
} from "./channel-guards";

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

/**
 * Team-chat ENGAGEMENT state — pins, reactions, read receipts and the mention
 * badge; split from the old ChannelsService 2026-07-31 (see
 * channel-messages.service.ts header for the full cut).
 */
@Injectable()
export class ChannelEngagementService {
  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

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
   * Pinned messages for a channel, newest-pin first. Each entry carries
   * the full message DTO so the pins panel renders without extra fetches.
   */
  async listPins(workspaceId: string, userId: string, channelId: string) {
    await requireChannelMembership(this.db, workspaceId, userId, channelId);
    return listChannelPins(channelId, workspaceId);
  }

  async pinMessage(
    workspaceId: string,
    userId: string,
    role: Role,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    await requireChannelMembership(this.db, workspaceId, userId, channelId);
    // Role-gate pinning in channels only. In a DM both participants may pin:
    // an admin who isn't in the DM can't reach it anyway, and a non-admin
    // shouldn't need permission to pin something in their own conversation.
    const channel = await requireChannelInTeam(this.db, workspaceId, channelId);
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
    await requireChannelMembership(this.db, workspaceId, userId, channelId);
    const channel = await requireChannelInTeam(this.db, workspaceId, channelId);
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
    await requireChannelMembership(this.db, workspaceId, userId, channelId);
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
    await requireChannelMembership(this.db, workspaceId, userId, channelId);
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

}
