import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";

import { parseMentions } from "@ccp/shared/team-chat/mentions";
import {
  canDeleteMessage,
  canEditMessage,
  EDIT_WINDOW_MS,
} from "@ccp/shared/team-chat/permissions";
import { blobStorage } from "@/lib/blob-storage";
import { MEDIA_SIZE_CAPS, kindFromMime } from "@/lib/media-storage";
import {
  buildMessagePreview,
  decodeCursor,
  listChannelMessages,
  listChannelMessagesAfter,
  listChannelMessagesAround,
  listThreadReplies as queryListThreadReplies,
  loadMessageForEmit,
  searchAllChannels,
  searchChannelMessages,
} from "@/lib/team-chat/queries";
import type { Role } from "@ccp/shared/types";

import { EventBus } from "../events/event-bus.module";
import { DbService } from "../db/db.service";
import type { ApiSession } from "../auth/session.guard";
import type { TeamChannelMessageDto } from "@ccp/shared/team-chat/types";
import type {
  EditChannelMessageInput,
  PostChannelMessageInput,
} from "./channels.schemas";
import {
  assertChannelWritable,
  isP2002,
  requireChannelMembership,
} from "./channel-guards";

/**
 * Team-chat MESSAGE operations — the read/post/edit/delete/thread/search/media
 * half of the old 2,083-line ChannelsService (split 2026-07-31). Channel
 * lifecycle + membership + DMs stay in ChannelsService; pins/reactions/read
 * receipts live in ChannelEngagementService. Access rules are shared via
 * channel-guards.ts, so the split cannot fork them.
 */
@Injectable()
export class ChannelMessagesService {
  private readonly logger = new Logger(ChannelMessagesService.name);

  constructor(
    private readonly db: DbService,
    private readonly bus: EventBus,
  ) {}

  async listMessages(
    workspaceId: string,
    userId: string,
    channelId: string,
    opts: { after?: string; before?: string; take?: number },
  ) {
    await requireChannelMembership(this.db, workspaceId, userId, channelId);

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
      requireChannelMembership(this.db, workspaceId, userId, channelId),
      assertChannelWritable(this.db, workspaceId, userId, channelId),
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
    await requireChannelMembership(this.db, workspaceId, userId, channelId);

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
    await requireChannelMembership(this.db, workspaceId, userId, channelId);
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
    await requireChannelMembership(this.db, workspaceId, userId, channelId);
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
    await requireChannelMembership(this.db, workspaceId, userId, channelId);
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
    await requireChannelMembership(this.db, workspaceId, userId, channelId);
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
      requireChannelMembership(this.db, workspaceId, userId, channelId),
      assertChannelWritable(this.db, workspaceId, userId, channelId),
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
    await requireChannelMembership(this.db, workspaceId, userId, channelId);
    await assertChannelWritable(this.db, workspaceId, userId, channelId);

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
        error: "file_too_large",
        detail: `File too large for ${kind}.`,
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
    await requireChannelMembership(this.db, workspaceId, userId, channelId);
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
