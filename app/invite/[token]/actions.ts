"use server";

import { Prisma } from "@prisma/client";
import { AuthError } from "next-auth";

import { signIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { hashInviteToken } from "@/lib/invite-token";
import { hashPassword, isPasswordBreached, validatePasswordStructure } from "@/lib/password";

/**
 * Accept an invite. The token in the URL is hashed and looked up; we verify
 * it's still pending and unexpired, create the User in the invite's team,
 * stamp the invite as accepted, then sign the user in and bounce them to
 * the inbox.
 *
 * Both the invite consumption and the user creation happen in a single
 * transaction so a failed user create (e.g. unique-email race against a
 * concurrent /register call) doesn't burn the invite.
 */

export interface AcceptState {
  error: string | null;
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
  const passwordHash = await hashPassword(password);

  let signInEmail: string;

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

      await tx.user.create({
        data: {
          teamId: invite.teamId,
          role: invite.role,
          name,
          email: invite.email,
          passwordHash,
        },
      });
      await tx.invite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });

      return { email: invite.email };
    });

    signInEmail = result.email;
  } catch (err) {
    if (err instanceof InviteError) return { error: err.message };
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: "An account with this email already exists." };
    }
    console.error("[invite/accept] failed", err);
    return { error: "Something went wrong accepting the invite." };
  }

  try {
    await signIn("credentials", {
      email: signInEmail,
      password,
      redirectTo: "/inbox",
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    if (err instanceof AuthError) {
      return { error: "Account created — please sign in." };
    }
    throw err;
  }

  return { error: null };
}

class InviteError extends Error {}

function isRedirectError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "digest" in err &&
    typeof (err as { digest?: unknown }).digest === "string" &&
    (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}
