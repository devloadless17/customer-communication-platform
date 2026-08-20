import type { PrismaClient, Prisma } from "@prisma/client";

type Db = Pick<PrismaClient, "operatorAccess" | "workspace">;

/**
 * Record a high-blast-radius OPERATOR action on the `OperatorAccess` log
 * (CLAUDE.md §18).
 *
 * The log used to record only workspace ENTRY, which answers "was the operator
 * here" but not "what did they do" — and four things the operator can do inside
 * a tenant deserve their own line, per the maintainer's explicit policy
 * ("allow, but record each"):
 *
 *   - "broadcast_send"          — spends the tenant's money at contact-book scale
 *   - "api_key_create"          — mints a long-lived credential to the tenant's data
 *   - "outbound_webhook_create" — points the tenant's event stream at an external URL
 *   - "contact_export"          — moves the tenant's whole contact book out
 *
 * AWAITED BEFORE the irreversible step, never after — same ordering the entry
 * route uses, and for the same reason: the record is the accountability, so a
 * failed write must fail the ACTION rather than allow an unlogged one. Callers
 * therefore do NOT wrap this in a try/catch that swallows.
 *
 * Callers gate on `session.isOperator` before calling: a real member's
 * broadcast is workforce activity, not operator activity, and logging it here
 * would drown the entries this log exists to surface. The org is resolved from
 * the workspace rather than the session because `session.organizationId` is
 * the operator's own anchor (see the wrong-org class in workspaces.service.ts).
 */
export async function recordOperatorAction(
  db: Db,
  args: {
    userId: string;
    workspaceId: string;
    action: "broadcast_send" | "api_key_create" | "outbound_webhook_create" | "contact_export";
    detail?: Prisma.InputJsonValue;
  },
): Promise<void> {
  const workspace = await db.workspace.findUnique({
    where: { id: args.workspaceId },
    select: { organizationId: true },
  });
  // A vanished workspace mid-action is a race the caller is about to lose
  // anyway (its own workspace-scoped write will find nothing) — don't fail the
  // log on it, and don't invent an org to file the row under.
  if (!workspace) return;
  await db.operatorAccess.create({
    data: {
      userId: args.userId,
      organizationId: workspace.organizationId,
      enteredWorkspaceId: args.workspaceId,
      action: args.action,
      ...(args.detail !== undefined ? { detail: args.detail } : {}),
    },
  });
}
