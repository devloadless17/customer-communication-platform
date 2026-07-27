import type { Prisma } from "@prisma/client";

/**
 * Join a member to the workspace's default channel (#general).
 *
 * ONE definition of "a new member of this workspace is in #general", because
 * the three membership-creating paths drifted: invite-accept and
 * `provisionWorkspace` both wrote the row, while `WorkspacesService.setMembership`
 * — the documented path for adding an EXISTING org user to a second workspace,
 * the one the invite flow's own conflict message points admins at — created
 * only the `WorkspaceMember` row.
 *
 * That gap is not cosmetic. `listChannelRowsForUser` and `searchAllChannels`
 * both intersect on real membership with no `isDefault` escape, so the member
 * saw an empty channel sidebar and got zero results from workspace-wide
 * team-chat search, permanently. Worse, `getDefaultChannel`'s primary branch
 * does NOT filter on membership, so `/team` still redirected them INTO
 * #general — and the web's `ChannelExistenceGuard` only tolerates that when
 * the member knows no channels at all. One DM (which does write both
 * membership rows) makes `knownCount > 0` and the guard bounces them back to
 * `/team`, which redirects to #general again: the infinite-refresh loop the
 * guard was written to end.
 *
 * Idempotent — `skipDuplicates` so a re-add after `remove-member.ts` cleared
 * the rows, or a concurrent double-submit, is a no-op rather than a P2002 that
 * would roll back the membership write it shares a transaction with.
 */
export async function joinDefaultChannel(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  userId: string,
  addedById: string | null,
): Promise<void> {
  const defaultChannel = await tx.teamChannel.findFirst({
    where: { workspaceId, isDefault: true },
    select: { id: true },
  });
  if (!defaultChannel) return;
  await tx.teamChannelMember.createMany({
    data: [{ channelId: defaultChannel.id, userId, addedById }],
    skipDuplicates: true,
  });
}
