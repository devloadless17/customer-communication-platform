"use server";

import { Prisma } from "@prisma/client";

import { signInWithCredentials } from "@/lib/auth";
import { auth } from "@/lib/auth/better-auth";
import { db } from "@/lib/db";
import { hashInviteToken } from "@/lib/auth/invite-token";
import { hashPassword, isPasswordBreached, validatePasswordStructure } from "@/lib/auth/password";
import { emitCatalogChange } from "@/lib/socket/server";

/**
 * Accept an invite. The token in the URL is hashed and looked up; we verify
 * it's still pending and unexpired, create the User + credential Account in
 * the invite's team, stamp the invite as accepted, then sign the user in
 * and bounce them to the inbox.
 *
 * Both the invite consumption and the user creation happen in a single
 * transaction so a failed user create (e.g. unique-email race against a
 * concurrent /register call) doesn't burn the invite. Better Auth's Account
 * row joins the same transaction for the same reason.
 */

export interface AcceptState {
  error: string | null;
  /** Destination for the client to navigate to after accepting the invite. */
  redirectTo?: string;
}

export async function acceptInviteAction(
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const token = String(formData.get("token") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!token) return { error: "Invite token missing." };
  if (!name) return { error: "Your name is required." };

  const policyError = validatePasswordStructure(password);
  if (policyError) return { error: policyError };
  if (await isPasswordBreached(password)) {
    return {
      error: "That password has appeared in known data breaches. Please choose another.",
    };
  }

  const tokenHash = hashInviteToken(token);
  const passwordHash =
    auth.options.emailAndPassword?.password?.hash
      ? await auth.options.emailAndPassword.password.hash(password)
      : await hashPassword(password);

  let signInEmail: string;
  let teamId: string;

  try {
    const result = await db.$transaction(async (tx) => {
      const invite = await tx.invite.findUnique({ where: { tokenHash } });
      if (!invite) throw new InviteError("This invite link is invalid.");
      if (invite.acceptedAt) throw new InviteError("This invite has already been used.");
      if (invite.expiresAt < new Date()) {
        throw new InviteError("This invite has expired. Ask your admin for a new link.");
      }

      // Race: someone may have registered with this email between the invite
      // create and now. The unique constraint on User.email is the final
      // guard; we surface a friendly message.
      const existing = await tx.user.findUnique({ where: { email: invite.email } });
      if (existing) {
        throw new InviteError("An account with this email already exists. Sign in instead.");
      }

      const user = await tx.user.create({
        data: {
          teamId: invite.teamId,
          role: invite.role,
          name,
          email: invite.email,
          passwordHash,
        },
      });
      await tx.account.create({
        data: {
          userId: user.id,
          providerId: "credential",
          accountId: invite.email,
          password: passwordHash,
        },
      });
      await tx.invite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });

      return { email: invite.email, teamId: invite.teamId };
    });

    signInEmail = result.email;
    teamId = result.teamId;
  } catch (err) {
    if (err instanceof InviteError) return { error: err.message };
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: "An account with this email already exists." };
    }
    console.error("[invite/accept] failed", err);
    return { error: "Something went wrong accepting the invite." };
  }

  // Fan out so any admin watching /settings/team sees the pending list
  // shrink (this invite is now accepted) AND the members list grow (the
  // new user just appeared). Single team-room emit for each scope; the
  // catalog-sync boundary on /settings calls router.refresh() and the
  // page re-fetches both lists in parallel.
  emitCatalogChange(teamId, "invites");
  emitCatalogChange(teamId, "members");

  const signIn = await signInWithCredentials(signInEmail, password);
  if (!signIn.ok) {
    console.error("[invite/accept] post-create sign-in failed:", signIn.error);
    return { error: "Account created — please sign in." };
  }

  // Do NOT call redirect() here — same Better Auth nextCookies + redirect
  // race that broke /login and /register. Hand the destination to the
  // client and let it navigate after the cookie lands.
  return { error: null, redirectTo: "/inbox" };
}

class InviteError extends Error {}
