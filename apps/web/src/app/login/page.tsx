import { redirect } from "next/navigation";
import { MessageSquareText } from "lucide-react";

import { getCurrentSession } from "@/lib/auth";
import { googleSignInEnabled } from "@/lib/auth/better-auth";

import { GoogleButton } from "./google-button";
import { LoginForm } from "./login-form";

export const metadata = {
  title: "Sign in · Loadless Inbox",
};

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  // Already signed in? Bounce to the role-router ("/" routes superAdmin →
  // /platform, pending org → /pending, else → /inbox) instead of re-showing
  // the form on a bookmarked /login or a back-nav. getCurrentSession() READS
  // the session without redirecting, so a stale/absent cookie can't loop —
  // we only redirect when a real session exists.
  const session = await getCurrentSession();
  if (session?.user?.id) redirect("/");
  const { next } = await searchParams;
  // Normalize "/" up front — it's a server component that redirects to
  // /inbox, and chaining that RSC redirect after the action-response
  // redirect breaks the Next.js client runtime ("An unexpected response
  // was received from the server"). Also reject protocol-relative and
  // external paths.
  const nextPath =
    typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && next !== "/"
      ? next
      : "/inbox";

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
          <h1 className="mb-1 text-base font-semibold tracking-tight">Sign in</h1>
          <p className="mb-5 text-xs text-muted-foreground">
            Use the email your admin invited you with.
          </p>

          {/* Google first, then the divider, then the form — the order every
              product with both uses, because the one-click path should not be
              below the fold of a password field. */}
          {googleSignInEnabled() && (
            <>
              <GoogleButton next={nextPath} label="Continue with Google" intent="login" />
              <div className="my-4 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-2xs text-muted-foreground">Or</span>
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}

          <LoginForm next={nextPath} />
        </div>

        <p className="mt-4 text-center text-2xs text-muted-foreground">
          New here?{" "}
          <a href="/register" className="text-primary hover:underline">
            Create a workspace
          </a>
        </p>
      </div>
    </div>
  );
}
