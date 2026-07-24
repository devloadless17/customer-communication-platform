"use server";

import { redirect } from "next/navigation";

import { auth } from "@/lib/auth/better-auth";
import { getCurrentSession } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Confirm the code, and re-send it.
 *
 * Both actions resolve the email from the SESSION, never from the form. Taking
 * it from the client would turn this screen into an open oracle: anyone could
 * post arbitrary addresses to request codes for accounts they don't own, or
 * brute-force a code against someone else's email.
 */

export interface VerifyState {
  error: string | null;
  /** Set after a successful resend so the form can confirm it without a nav. */
  notice?: string | null;
}

async function currentEmail(): Promise<string | null> {
  const session = await getCurrentSession();
  if (!session?.user?.id) return null;
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  return user?.email ?? null;
}

export async function verifyCodeAction(
  _prev: VerifyState,
  formData: FormData,
): Promise<VerifyState> {
  // Strip spaces/dashes people paste from the email client.
  const code = String(formData.get("code") ?? "").replace(/\D/g, "");
  if (code.length !== 6) return { error: "Enter the 6-digit code." };

  const email = await currentEmail();
  if (!email) redirect("/login");

  try {
    await auth.api.verifyEmailOTP({ body: { email, otp: code } });
  } catch {
    // Deliberately one message for wrong-code and expired-code. Distinguishing
    // them tells an attacker whether a guessed code existed, and the user's
    // next action ("request a new one") is the same either way.
    return { error: "That code is wrong or has expired. Request a new one." };
  }

  // Straight to the next gate. /pending forwards to the app the moment the org
  // is approved, so an already-approved org never sees it.
  redirect("/pending");
}

export async function resendCodeAction(): Promise<VerifyState> {
  const email = await currentEmail();
  if (!email) redirect("/login");

  try {
    await auth.api.sendVerificationOTP({
      body: { email, type: "email-verification" },
    });
  } catch (err) {
    console.error("[verify] resend failed:", err);
    return { error: "We couldn't send the code. Try again in a moment." };
  }
  return { error: null, notice: "Sent — check your inbox." };
}
