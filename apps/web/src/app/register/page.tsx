import { redirect } from "next/navigation";
import Link from "next/link";
import { MessageSquareText } from "lucide-react";

import { getCurrentSession } from "@/lib/auth";
import { googleSignInEnabled } from "@/lib/auth/better-auth";
import { GoogleButton } from "@/app/login/google-button";

import { RegisterForm } from "./register-form";

export const metadata = {
  title: "Create account · Loadless Inbox",
};

export default async function RegisterPage() {
  // Already signed in → role-router, not the create-workspace form (same
  // non-redirecting session read as /login, so no loop on a stale cookie).
  const session = await getCurrentSession();
  if (session?.user?.id) redirect("/");
  return (
    <div className="grid min-h-svh place-items-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <MessageSquareText className="size-4" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Loadless Inbox</div>
            <div className="text-2xs text-muted-foreground">Shared WhatsApp inbox</div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-xs">
          <h1 className="mb-1 text-base font-semibold tracking-tight">
            Create your workspace
          </h1>
          <p className="mb-5 text-xs text-muted-foreground">
            You&apos;ll own the organization. Connect your WhatsApp number after
            sign-up — that takes about 5 minutes.
          </p>

          {/* Same button as sign-in: Google is one handshake, and a first-time
              address gets its organization provisioned on arrival. Splitting it
              into "sign in with" vs "sign up with" would imply a choice the
              user doesn't actually have to make. */}
          {googleSignInEnabled() && (
            <>
              <GoogleButton next="/inbox" label="Continue with Google" />
              <div className="my-4 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-2xs text-muted-foreground">Or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}

          <RegisterForm />
        </div>

        <p className="mt-4 text-center text-2xs text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
