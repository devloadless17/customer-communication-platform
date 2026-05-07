import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { assignableRoles } from "@/lib/permissions";
import type { Role } from "@/lib/types";

/**
 * Admin-only: invite a new user to the team. Body: `{ name, email, role,
 * password }`. Returns the created row sans hash.
 *
 * Invite-only: there is no self-signup. The pilot model is "admin onboards
 * agents," matching how Front/Intercom do it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  name?: unknown;
  email?: unknown;
  role?: unknown;
  password?: unknown;
}

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const password = typeof raw.password === "string" ? raw.password : "";

  // Server-side role validation: actor can only invite a role they are
  // allowed to assign. Default to "agent" if the client didn't send one.
  const allowed = assignableRoles(session.role);
  const requestedRole =
    typeof raw.role === "string" && (allowed as string[]).includes(raw.role)
      ? (raw.role as Role)
      : null;
  const role: Role = requestedRole ?? "agent";
  if (!allowed.includes(role)) {
    return NextResponse.json({ error: "role not assignable by you" }, { status: 403 });
  }

  if (!name || !email || password.length < 8) {
    return NextResponse.json(
      { error: "name, email, and an 8+ character password are required" },
      { status: 400 },
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }

  const passwordHash = await hashPassword(password);

  try {
    const user = await db.user.create({
      data: {
        teamId: session.teamId,
        role,
        name,
        email,
        passwordHash,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        deactivatedAt: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ user });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "email already in use" }, { status: 409 });
    }
    throw err;
  }
}
