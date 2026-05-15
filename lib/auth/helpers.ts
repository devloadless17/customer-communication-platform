import "server-only";

import { NextResponse } from "next/server";

import { loadActiveUser } from "@/lib/auth/active-user";
import { getCurrentSession, signOutCurrentSession } from "@/lib/auth";
import { canManageUsers } from "@/lib/auth/permissions";
import type { Role } from "@/lib/types";

/**
 * Server-side guards for API routes. Throw a sentinel response on failure so
 * callers can `return` it directly:
 *
 *   const session = await requireSession();
 *   if (session instanceof NextResponse) return session;
 *
 * Returning a NextResponse on the failure branch keeps every route's happy
 * path readable — no try/catch around the auth check.
 */

export interface ApiSession {
  userId: string;
  teamId: string;
  role: Role;
  name: string;
  email: string;
}

export async function requireSession(): Promise<ApiSession | NextResponse> {
  const session = await getCurrentSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Re-check the DB so an admin who just deactivated a user can't be served
  // for the remaining lifetime of that session row. Cheap and important —
  // without this, deactivation is up to 90 days late for API routes.
  // (Pages already do this via lib/auth/current-user.ts → getSession.)
  const user = await loadActiveUser(session.user.id);
  if (!user) {
    // Session row exists but the underlying user is gone/deactivated. Tear
    // down the session so the next request doesn't repeat the work — and
    // so the cookie doesn't keep masquerading as logged-in.
    await signOutCurrentSession();
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return {
    userId: user.id,
    teamId: user.teamId,
    role: user.role,
    name: user.name,
    email: user.email,
  };
}

/**
 * For routes that mutate users (invite, role change, deactivate). Allows
 * admin and superAdmin only. Anyone signed in can view the team directory,
 * so there's no read-side guard — see /settings/team/page.tsx.
 */
export async function requireAdmin(): Promise<ApiSession | NextResponse> {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (!canManageUsers(session.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return session;
}

/**
 * superAdmin gate — used by the cross-team admin section. superAdmin is a
 * platform-level role (one or two per deployment) that can browse every
 * org's basic data. Per CLAUDE.md the platform stays multi-tenant; this
 * helper is the ONE place that legitimately steps outside team boundaries.
 */
export async function requireSuperAdmin(): Promise<ApiSession | NextResponse> {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;
  if (session.role !== "superAdmin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return session;
}
