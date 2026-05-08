import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { generateInviteToken, hashInviteToken, inviteExpiry } from "@/lib/invite-token";
import { assignableRoles } from "@/lib/permissions";
import type { Role } from "@/lib/types";

/**
 * Admin-only: create an invite link for a teammate.
 *
 * Body: `{ name?, email, role }`. Returns `{ url, expiresAt }` — the admin
 * shares this link out-of-band (DM, email). The URL is the only place the
 * raw token ever appears; the DB stores its hash.
 *
 * Email field is enforced unique per team for *pending* invites — re-issuing
 * for the same email replaces the prior token, which is the right UX
 * (admin clicks "resend" → previous link is invalidated).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  email?: unknown;
  role?: unknown;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "invalid email" }, { status: 400 });
  }

  const allowed = assignableRoles(session.role);
  const requestedRole =
    typeof raw.role === "string" && (allowed as string[]).includes(raw.role)
      ? (raw.role as Role)
      : null;
  const role: Role = requestedRole ?? "agent";
  if (!allowed.includes(role)) {
    return NextResponse.json({ error: "role not assignable by you" }, { status: 403 });
  }

  // Reject if a user with this email already exists anywhere — User.email is
  // globally unique. We catch this here to give a friendly error before we
  // bother creating an invite that can't ever be accepted.
  const existingUser = await db.user.findUnique({ where: { email } });
  if (existingUser) {
    return NextResponse.json({ error: "email already in use" }, { status: 409 });
  }

  // Wipe any prior pending invite for this (team, email) so the new link is
  // the only valid one. We don't touch already-accepted invites — those are
  // historical audit rows.
  await db.invite.deleteMany({
    where: { teamId: session.teamId, email, acceptedAt: null },
  });

  const token = generateInviteToken();
  const tokenHash = hashInviteToken(token);
  const invite = await db.invite.create({
    data: {
      teamId: session.teamId,
      email,
      role,
      tokenHash,
      createdById: session.userId,
      expiresAt: inviteExpiry(),
    },
    select: { id: true, expiresAt: true },
  });

  // Build the share URL from the request origin so dev (ngrok) and prod
  // (your real domain) Just Work without an env var. NEXTAUTH_URL would be
  // wrong on the rotating ngrok URL.
  const origin = new URL(req.url).origin;
  const url = `${origin}/invite/${token}`;

  return NextResponse.json({
    invite: { id: invite.id, expiresAt: invite.expiresAt.toISOString(), url },
  });
}
