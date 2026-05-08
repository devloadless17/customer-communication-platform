import "server-only";

import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { canManageUsers } from "@/lib/permissions";
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
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return {
    userId: session.user.id,
    teamId: session.user.teamId,
    role: session.user.role,
    name: session.user.name ?? "",
    email: session.user.email ?? "",
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
