"use server";

import { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";

import { signInWithCredentials } from "@/lib/auth";
import { auth } from "@/lib/auth/better-auth";
import { db } from "@/lib/db";
import { hashPassword, isPasswordBreached, validatePasswordStructure } from "@/lib/auth/password";

/**
 * Org self-signup. Creates a brand-new Team + admin User + a credential
 * Account row in one transaction, then signs the user in. The team starts
 * with zero WhatsApp config; the admin is dropped into /settings/whatsapp
 * to connect.
 *
 * Why a transaction: a dangling Team with no users would orphan the org —
 * worse, an admin User without a Team would 500 on every page load. Better
 * Auth's Account row needs to land in the same transaction as the User so
 * a partial failure leaves nothing behind.
 *
 * Why we hash the password ourselves and create the Account row directly
 * (instead of calling auth.api.signUpEmail): the Account row needs to be
 * inside our team-creating transaction. signUpEmail issues its own create,
 * which would either succeed without a team or fight the transaction.
 */

export interface RegisterState {
  error: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function registerAction(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const orgName = String(formData.get("orgName") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!orgName) return { error: "Organization name is required." };
  if (!name) return { error: "Your name is required." };
  if (!EMAIL_RE.test(email)) return { error: "Enter a valid email." };

  const policyError = validatePasswordStructure(password);
  if (policyError) return { error: policyError };
  if (await isPasswordBreached(password)) {
    return {
      error: "That password has appeared in known data breaches. Please choose another.",
    };
  }

  // Run our hash via Better Auth's configured hasher so future config
  // changes (cost factor, algorithm) propagate to signups automatically.
  // Falls through to bcryptjs under the hood today (see lib/auth/better-auth.ts).
  const passwordHash =
    auth.options.emailAndPassword?.password?.hash
      ? await auth.options.emailAndPassword.password.hash(password)
      : await hashPassword(password);

  try {
    await db.$transaction(async (tx) => {
      const team = await tx.team.create({ data: { name: orgName } });
      const user = await tx.user.create({
        data: {
          teamId: team.id,
          role: "admin",
          name,
          email,
          // Keep User.passwordHash populated for now so any code path still
          // reading it (legacy seed scripts, ad-hoc maintenance) keeps
          // working. Better Auth's verify step reads Account.password.
          passwordHash,
        },
      });
      await tx.account.create({
        data: {
          userId: user.id,
          providerId: "credential",
          accountId: email,
          password: passwordHash,
        },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: "That email is already in use." };
    }
    console.error("[register] failed", err);
    return { error: "Something went wrong creating your account." };
  }

  // Sign the user in with the password they just set. Goes through the same
  // wrapper as the login form so the lockout limiter and (vacuous here)
  // deactivation check stay in lockstep across entry points.
  const signIn = await signInWithCredentials(email, password);
  if (!signIn.ok) {
    console.error("[register] post-create sign-in failed:", signIn.error);
    return { error: "Account created — please sign in." };
  }

  redirect("/settings/whatsapp");
}
