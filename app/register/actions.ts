"use server";

import { Prisma } from "@prisma/client";

import { signIn } from "@/lib/auth";
import { db } from "@/lib/db";
import { hashPassword, isPasswordBreached, validatePasswordStructure } from "@/lib/auth/password";

/**
 * Org self-signup. Creates a brand-new Team + admin User in one transaction
 * and immediately signs the user in. The team starts with zero WhatsApp
 * config; the admin is dropped into /settings/whatsapp to connect.
 *
 * Why a transaction: a dangling Team with no users would orphan the org —
 * worse, an admin User without a Team would 500 on every page load.
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

  const passwordHash = await hashPassword(password);

  try {
    await db.$transaction(async (tx) => {
      const team = await tx.team.create({ data: { name: orgName } });
      await tx.user.create({
        data: {
          teamId: team.id,
          role: "admin",
          name,
          email,
          passwordHash,
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

  try {
    // signIn throws NEXT_REDIRECT — same dance as the login action.
    await signIn("credentials", {
      email,
      password,
      redirectTo: "/settings/whatsapp",
    });
  } catch (err) {
    if (isRedirectError(err)) throw err;
    // Don't `instanceof AuthError` — production bundling can break the
    // prototype chain across server-action / auth chunks. Catch everything.
    console.error("[register] post-create sign-in failed:", err);
    return { error: "Account created — please sign in." };
  }

  return { error: null };
}

function isRedirectError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "digest" in err &&
    typeof (err as { digest?: unknown }).digest === "string" &&
    (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}
