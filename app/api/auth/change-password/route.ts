import { NextResponse } from "next/server";

import { requireSession } from "@/lib/auth/helpers";
import { db } from "@/lib/db";
import {
  hashPassword,
  isPasswordBreached,
  validatePasswordStructure,
  verifyPassword,
} from "@/lib/auth/password";

/**
 * Self-service password change. Requires the current password to prevent a
 * leaked session cookie from rotating credentials.
 *
 * Body: `{ currentPassword, newPassword }`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  currentPassword?: unknown;
  newPassword?: unknown;
}

export async function POST(req: Request) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  let raw: Body;
  try {
    raw = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const currentPassword = typeof raw.currentPassword === "string" ? raw.currentPassword : "";
  const newPassword = typeof raw.newPassword === "string" ? raw.newPassword : "";

  const policyError = validatePasswordStructure(newPassword);
  if (policyError) {
    return NextResponse.json({ error: policyError }, { status: 400 });
  }

  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user || !user.passwordHash) {
    return NextResponse.json({ error: "no password set" }, { status: 400 });
  }

  // Verify the CURRENT password before any expensive checks — keeps a stolen
  // session cookie from spamming HIBP queries with arbitrary candidates.
  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "current password is incorrect" }, { status: 400 });
  }

  if (await isPasswordBreached(newPassword)) {
    return NextResponse.json(
      { error: "that password has appeared in known data breaches. Please choose another." },
      { status: 400 },
    );
  }

  const newHash = await hashPassword(newPassword);
  // Better Auth verifies signin credentials against Account.password, not
  // User.passwordHash. If we only updated User.passwordHash, the new password
  // would fail signin and the OLD password would still work. Update both in
  // one transaction so the two columns can't diverge.
  await db.$transaction([
    db.user.update({ where: { id: user.id }, data: { passwordHash: newHash } }),
    db.account.updateMany({
      where: { userId: user.id, providerId: "credential" },
      data: { password: newHash },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
