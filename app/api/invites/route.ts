import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import { generateInviteToken, hashInviteToken, inviteExpiry } from "@/lib/auth/invite-token";
import { assignableRoles } from "@/lib/auth/permissions";
import type { Role } from "@/lib/types";
import { emitCatalogChange } from "@/lib/socket/server";

/**
 * Admin-only: list every PENDING invite for the team (un-accepted,
 * un-expired). Drives the "Pending invites" panel in /settings/team so
 * admins can see who's been invited and revoke a link before it's used.
 *
 * Filters out accepted invites (those are audit rows; the redeeming user
 * shows up in the team list instead) and expired ones (the accept-page
 * already rejects them; surfacing them just clutters the UI).
 */
export async function GET() {
  const session = await requireAdmin();
  if (session instanceof NextResponse) return session;
  const { teamId } = session;

  const rows = await db.invite.findMany({
    where: {
      teamId,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      expiresAt: true,
      createdAt: true,
      createdBy: { select: { name: true } },
    },
  });

  return NextResponse.json({
    invites: rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role as Role,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      createdByName: r.createdBy?.name ?? "Removed user",
    })),
  });
}

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
  //
  // Opportunistic side-cleanup: drop EXPIRED un-accepted invites for this
  // team in the same query. Avoids a separate cron job for what is a
  // low-volume table; the accept-page already rejects expired tokens, so
  // these are just data hygiene. Scoped to teamId to keep the query bounded.
  await db.invite.deleteMany({
    where: {
      teamId: session.teamId,
      acceptedAt: null,
      OR: [
        { email },
        { expiresAt: { lt: new Date() } },
      ],
    },
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

  // Build the share URL from BETTER_AUTH_URL (the canonical public origin)
  // when set, else fall back to req.url. Behind a reverse proxy `req.url`
  // can resolve to the server's listening address (e.g. 0.0.0.0:3000),
  // which would produce unusable invite links in emails.
  const origin = process.env.BETTER_AUTH_URL || new URL(req.url).origin;
  const url = `${origin.replace(/\/$/, "")}/invite/${token}`;

  // Tell every admin's open /settings/team tab that the pending list moved.
  // The catalog-sync boundary mounted on /settings calls router.refresh()
  // which re-runs the page server component and re-fetches the list.
  emitCatalogChange(session.teamId, "invites");

  return NextResponse.json({
    invite: { id: invite.id, expiresAt: invite.expiresAt.toISOString(), url },
  });
}
