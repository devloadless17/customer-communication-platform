import { redirect } from "next/navigation";

import { getCurrentSession } from "@/lib/auth";
import { db } from "@/lib/db";

import { VerifyForm } from "./verify-form";

export const metadata = { title: "Verify your email" };
export const dynamic = "force-dynamic";

/**
 * Email-verification screen — the one step between signing up and having an
 * account that can do anything.
 *
 * OUTSIDE the (app) route group, and it deliberately does NOT call
 * `getSession()`. That helper redirects an unverified user *here*, so using it
 * on this page would be an infinite loop. It reads the Better Auth session
 * directly and does its own narrow lookup instead.
 *
 * Self-heals in both directions: someone who is already verified (they came
 * back to the URL, or verified in another tab) is forwarded on, and someone
 * with no session at all goes to /login rather than seeing a code box for an
 * account that doesn't exist.
 */
export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ send?: string }>;
}) {
  const { send } = await searchParams;
  // Set by registerAction when the very first send threw. Without it the screen
  // claimed "we sent a code" over a message that never left the building.
  const sendFailed = send === "failed";
  const session = await getCurrentSession();
  if (!session?.user?.id) redirect("/login");

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { email: true, emailVerified: true, isSuperAdmin: true },
  });
  if (!user) redirect("/logout");

  // Already done — don't make them prove it twice. /pending is the next gate
  // (org approval) and self-heals to the app once approved.
  if (user.emailVerified || user.isSuperAdmin) redirect("/pending");

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-sm rounded-xl border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">
          {sendFailed ? "We couldn't send your code" : "Check your email"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {sendFailed ? (
            <>
              Your account is created, but the code to{" "}
              <strong className="font-medium text-foreground">{user.email}</strong>{" "}
              didn&apos;t go out. Use Resend below — if it keeps failing, contact
              support.
            </>
          ) : (
            <>
              We sent a 6-digit code to{" "}
              <strong className="font-medium text-foreground">{user.email}</strong>.
            </>
          )}
        </p>
        <VerifyForm />
      </div>
    </main>
  );
}
