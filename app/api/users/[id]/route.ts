import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { assignableRoles, canModifyUser } from "@/lib/auth/permissions";
import { disconnectUserSockets, emitCatalogChange } from "@/lib/socket/server";
import type { Role } from "@/lib/types";

/**
 * Admin-or-superAdmin: change a user's role or activate/deactivate them.
 * Body: `{ role?: Role, deactivated?: boolean }`.
 *
 * Layered guards:
 *   1) Actor must be allowed to touch the target (canModifyUser) — this
 *      blocks an admin from modifying a superAdmin.
 *   2) Actor must be allowed to assign the requested role (assignableRoles)
 *      — this blocks an admin from promoting someone to superAdmin.
 *   3) Self-edit guards: can't demote / deactivate yourself.
 *   4) Last-active-manager guard: don't lock the team out by removing the
 *      only person with user-management powers.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  role?: unknown;
  deactivated?: unknown;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const { id } = await ctx.params;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const target = await db.user.findFirst({
    where: { id, teamId: session.teamId },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!target) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  // Guard 1: actor allowed to touch target?
  if (!canModifyUser(session.role, target.role)) {
    return NextResponse.json({ error: "cannot modify this user" }, { status: 403 });
  }

  const data: { role?: Role; deactivatedAt?: Date | null } = {};

  // Guard 2: requested role must be assignable by the actor.
  const allowed = assignableRoles(session.role);
  if (typeof raw.role === "string") {
    if (!(allowed as string[]).includes(raw.role)) {
      return NextResponse.json(
        { error: "role not assignable by you" },
        { status: 403 },
      );
    }
    data.role = raw.role as Role;
  }
  if (typeof raw.deactivated === "boolean") {
    data.deactivatedAt = raw.deactivated ? new Date() : null;
  }

  // Guard 3: self-edit safeguards.
  if (id === session.userId) {
    if (data.role && data.role !== session.role) {
      return NextResponse.json(
        { error: "cannot change your own role" },
        { status: 400 },
      );
    }
    if (data.deactivatedAt) {
      return NextResponse.json(
        { error: "cannot deactivate yourself" },
        { status: 400 },
      );
    }
  }

  // Guard 4: don't strip the team of every active manager. "Manager" here
  // means anyone who can manage users — admin or superAdmin. Demoting or
  // disabling the last one would lock everyone out of /settings/team.
  const willLoseManagerPowers =
    (data.role && data.role !== "admin" && data.role !== "superAdmin") ||
    data.deactivatedAt;
  const targetCurrentlyManages =
    (target.role === "admin" || target.role === "superAdmin") &&
    !target.deactivatedAt;
  if (willLoseManagerPowers && targetCurrentlyManages) {
    const otherManagers = await db.user.count({
      where: {
        teamId: session.teamId,
        role: { in: ["admin", "superAdmin"] },
        deactivatedAt: null,
        NOT: { id },
      },
    });
    if (otherManagers === 0) {
      return NextResponse.json(
        { error: "cannot remove the last active admin" },
        { status: 400 },
      );
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "no changes" }, { status: 400 });
  }

  const updated = await db.user.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      deactivatedAt: true,
      createdAt: true,
    },
  });

  // If we just deactivated the user, drop their Session rows so the in-cookie
  // 5-min session cache can't keep authorizing them after this point. Without
  // this, page navs + API routes still kick them out via `loadActiveUser`,
  // but their open Socket.io connections and any fresh socket inside the
  // cache window would continue to pass. Belt-and-braces with the new
  // handshake-time deactivation check in lib/socket/server.ts.
  //
  // Also hard-disconnect every live socket the user has open right now —
  // the handshake gate only catches NEW connections; an already-connected
  // socket would keep receiving live team events until the user happened
  // to reload.
  if (data.deactivatedAt) {
    await db.session.deleteMany({ where: { userId: id } });
    const dropped = disconnectUserSockets(id);
    if (dropped > 0) {
      console.info(`[users.deactivate] dropped ${dropped} live socket(s) for user=${id}`);
    }
  }

  // Roster mutation — fan out so other admins viewing the team page and
  // the inbox shell (which renders teammates for presence + attribution)
  // pull fresh data. Also covers the case where a teammate is deactivated
  // while another agent has them in a typing / presence list.
  emitCatalogChange(session.teamId, "members");
  return NextResponse.json({ user: updated });
}

/**
 * Hard-delete a team member. Permanently removes the User row plus their
 * Session + Account rows (Cascade). Historical attribution survives via
 * SetNull FKs — messages, notes, broadcasts, snippets, audience groups,
 * and invites they authored remain in the DB, just unlinked. The UI
 * renders them as "Removed user."
 *
 * Same authorization gates as PATCH:
 *   - actor canModifyUser(target) — admin can't delete a superAdmin
 *   - last-active-admin guard — never strip the team of every manager
 *   - self-delete refused — admins should disable themselves elsewhere
 *     first; preventing accidental self-locks-out is worth more than the
 *     small inconvenience
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  const { id } = await ctx.params;

  const target = await db.user.findFirst({
    where: { id, teamId: session.teamId },
    select: { id: true, role: true, deactivatedAt: true },
  });
  if (!target) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  if (!canModifyUser(session.role, target.role)) {
    return NextResponse.json({ error: "cannot delete this user" }, { status: 403 });
  }

  if (id === session.userId) {
    return NextResponse.json(
      { error: "cannot delete your own account" },
      { status: 400 },
    );
  }

  // Last-active-manager guard. Deleting the only person who can manage users
  // locks the team out of /settings/team forever. Same shape as the PATCH
  // deactivation guard.
  const targetCurrentlyManages =
    (target.role === "admin" || target.role === "superAdmin") &&
    !target.deactivatedAt;
  if (targetCurrentlyManages) {
    const otherManagers = await db.user.count({
      where: {
        teamId: session.teamId,
        role: { in: ["admin", "superAdmin"] },
        deactivatedAt: null,
        NOT: { id },
      },
    });
    if (otherManagers === 0) {
      return NextResponse.json(
        { error: "cannot delete the last active admin" },
        { status: 400 },
      );
    }
  }

  await db.user.delete({ where: { id } });
  // Same reasoning as PATCH-deactivate: kick the user's live sockets so
  // they don't keep receiving team events between this delete and their
  // next reload (when the catalog-change forces it).
  const dropped = disconnectUserSockets(id);
  if (dropped > 0) {
    console.info(`[users.delete] dropped ${dropped} live socket(s) for user=${id}`);
  }
  emitCatalogChange(session.teamId, "members");
  return NextResponse.json({ ok: true });
}
