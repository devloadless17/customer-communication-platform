import type { PrismaClient } from "@prisma/client";

/** Seeded into every new workspace — kept in lockstep with the backfill in
 *  prisma/migrations/20260722140000_seed_default_message_flags. */
export const DEFAULT_MESSAGE_FLAGS = [
  { name: "Complaint", color: "rose", description: "The customer is unhappy — needs a follow-up." },
  { name: "Refund request", color: "amber", description: "The customer asked for money back." },
  { name: "Follow up", color: "sky", description: "Come back to this one later." },
  {
    name: "Urgent",
    color: "orange",
    description: "Needs attention before anything else in the queue.",
  },
] as const;

/**
 * Everything a NEW workspace contains on day one, in one place.
 *
 * Extracted from the signup transaction so a workspace created later from
 * Organization settings is byte-identical to the one a signup provisions.
 * Two copies of "what a new workspace contains" would drift the first time
 * someone added a default — and the drift would be invisible until a customer
 * asked why their second workspace has no pipeline.
 *
 * Runs INSIDE the caller's transaction: a half-seeded workspace (rows but no
 * #general, or stages but no membership) is worse than no workspace at all.
 */

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

export interface ProvisionWorkspaceArgs {
  organizationId: string;
  name: string;
  /** Becomes the workspace's first admin and #general's first member. */
  founderUserId: string;
}

export async function provisionWorkspace(
  tx: Tx,
  args: ProvisionWorkspaceArgs,
): Promise<{ id: string; name: string }> {
  const workspace = await tx.workspace.create({
    data: { name: args.name, organizationId: args.organizationId },
    select: { id: true, name: true },
  });

  // Starter message-flag definitions. The flags feature is INVISIBLE until a
  // definition exists (the message "…" menu hides "Flag as" on an empty
  // catalog), so a workspace without these would never discover it.
  await tx.messageFlagDefinition.createMany({
    data: DEFAULT_MESSAGE_FLAGS.map((f, i) => ({
      workspaceId: workspace.id,
      name: f.name,
      color: f.color,
      description: f.description,
      sortOrder: i,
    })),
  });

  // Three lifecycle stages so the inbox sidebar shows a real pipeline from the
  // first login. Renameable in /settings/stages.
  await tx.contactStage.createMany({
    data: [
      { workspaceId: workspace.id, name: "Stage 1", color: "lime", position: 0, isDefault: true },
      { workspaceId: workspace.id, name: "Stage 2", color: "amber", position: 1, isDefault: false },
      {
        workspaceId: workspace.id,
        name: "Stage 3",
        color: "emerald",
        position: 2,
        isDefault: false,
      },
    ],
  });

  await tx.workspaceMember.create({
    data: { userId: args.founderUserId, workspaceId: workspace.id, role: "admin" },
  });

  // Default #general. `/team` redirects to it on first login; without this row
  // the team-chat surface lands on a "No channels yet" dead end.
  const channel = await tx.teamChannel.create({
    data: {
      workspaceId: workspace.id,
      name: "general",
      isDefault: true,
      // EXPLICIT: the column defaults to `private`. #general must be public —
      // it is the one channel every member is guaranteed to reach, and `update`
      // refuses to change a default channel's visibility, so a private one
      // would be unfixable.
      visibility: "public",
      createdById: args.founderUserId,
    },
    select: { id: true },
  });
  await tx.teamChannelMember.create({
    data: { channelId: channel.id, userId: args.founderUserId, addedById: args.founderUserId },
  });

  return workspace;
}
