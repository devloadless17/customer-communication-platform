import type { Prisma } from "@prisma/client";

import { provisionWorkspace } from "@/lib/workspaces/provision";

/**
 * Everything a brand-new tenant needs, in one transaction.
 *
 * WHY THIS IS EXTRACTED. There are now two ways to become a customer — paste a
 * password, or click "Continue with Google" — and both have to produce an
 * identical tenant. Duplicating the sequence is exactly how the two drift:
 * one path forgets `status: "pending"` and skips the approval gate, or seeds a
 * different set of stages, and the difference only surfaces weeks later as
 * "why does this org behave oddly". One implementation, two callers.
 *
 * What it deliberately does NOT do: hash a password or create an `Account` row.
 * The credential path supplies its own hash; the Google path has no password at
 * all and lets Better Auth write the oauth account. Baking either in would make
 * this function lie to one of its two callers.
 *
 * MUST be called inside a transaction. A half-provisioned tenant — an
 * Organization with no Workspace, or a User with no membership — 500s on every
 * page load, and there is no UI to repair it.
 */
export async function provisionOrganization(
  tx: Prisma.TransactionClient,
  args: {
    /** Organization name. For Google signup this is derived from the profile
     *  and renamed by the user immediately afterwards. */
    orgName: string;
    /** The founder. */
    name: string;
    email: string;
    /**
     * Whether the address is already proven. `true` only for Google (the
     * provider asserts a verified email); the password path leaves this false
     * and sends an OTP.
     */
    emailVerified: boolean;
    avatarUrl?: string | null;
  },
): Promise<{ organizationId: string; userId: string; workspaceId: string }> {
  // `status: pending` — explicit, though it is also the column default. The org
  // exists but is locked out of the app until a super-admin approves it. This
  // is the gate that makes an abandoned signup harmless.
  const organization = await tx.organization.create({
    data: { name: args.orgName, status: "pending" },
  });

  // The founder OWNS the org (billing + directory) and is admin of the starter
  // workspace — two separate grants, not one role column.
  const user = await tx.user.create({
    data: {
      organizationId: organization.id,
      orgRole: "owner",
      name: args.name,
      email: args.email,
      emailVerified: args.emailVerified,
      ...(args.avatarUrl ? { avatarUrl: args.avatarUrl } : {}),
    },
  });

  // Stages, starter flags, #general and the founder's admin membership all live
  // in provisionWorkspace so a workspace created later from Organization
  // settings is identical to this one.
  const workspace = await provisionWorkspace(tx, {
    organizationId: organization.id,
    name: args.orgName,
    founderUserId: user.id,
  });

  return { organizationId: organization.id, userId: user.id, workspaceId: workspace.id };
}
