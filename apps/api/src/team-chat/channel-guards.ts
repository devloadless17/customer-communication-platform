import { NotFoundException, UnprocessableEntityException } from "@nestjs/common";

import type { DbService } from "../db/db.service";

/**
 * The team-chat access guards, shared by the three channel services
 * (`ChannelsService` — lifecycle/membership/DMs, `ChannelMessagesService`,
 * `ChannelEngagementService`) after the 2026-07-31 split of the old
 * 2,083-line ChannelsService. Standalone functions taking `db` so the split
 * couldn't fork the rules: there is exactly ONE definition of "may this user
 * touch this channel", however many services enforce it.
 */

/** The channel exists in THIS workspace, or 404. Returns the row's guard-relevant fields. */
export async function requireChannelInTeam(
  db: DbService,
  workspaceId: string,
  channelId: string,
) {
  const channel = await db.teamChannel.findFirst({
    where: { id: channelId, workspaceId },
    select: { id: true, isDefault: true, kind: true, visibility: true },
  });
  if (!channel) throw new NotFoundException({ error: "channel_not_found" });
  return channel;
}

/**
 * Reject channel-administration operations targeting a DM.
 *
 * LOAD-BEARING. Without this, `POST /api/team-chat/channels/:dmId/members` would
 * let an admin inject a third party into two colleagues' private 1:1 — the
 * existing members_changed fanout would dutifully wire the new member into
 * the room and hand them the full history. It also breaks the 1:1 invariant
 * that `dmKey` exists to guarantee.
 *
 * 404 rather than 400/403 so the response is indistinguishable from "no such
 * channel", matching the non-disclosure posture used everywhere else here.
 */
export function assertNotDm(channel: { kind: string }): void {
  if (channel.kind === "dm") {
    throw new NotFoundException({ error: "channel_not_found" });
  }
}

/** Viewer must be a member (default channel: everyone implicitly is), or 404. */
export async function requireChannelMembership(
  db: DbService,
  workspaceId: string,
  userId: string,
  channelId: string,
): Promise<void> {
  const channel = await db.teamChannel.findFirst({
    where: { id: channelId, workspaceId },
    select: { id: true, isDefault: true },
  });
  if (!channel) throw new NotFoundException({ error: "channel_not_found" });
  if (channel.isDefault) return; // Everyone is implicitly a member.
  const member = await db.teamChannelMember.findUnique({
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
 * stays available. Only the send paths call this.
 *
 * A self-DM ("notes to self") has no other member, so `peer` is null and the
 * check passes — that conversation must keep working.
 */
export async function assertChannelWritable(
  db: DbService,
  workspaceId: string,
  userId: string,
  channelId: string,
): Promise<void> {
  const channel = await db.teamChannel.findFirst({
    where: { id: channelId, workspaceId },
    select: { kind: true },
  });
  if (channel?.kind !== "dm") return;
  const peer = await db.teamChannelMember.findFirst({
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

/** Prisma unique-violation check, shared by the three channel services. */
export function isP2002(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}
