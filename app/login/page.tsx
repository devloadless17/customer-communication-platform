import { MessageSquareText } from "lucide-react";

import { auth } from "@/lib/auth";

import { LoginForm } from "./login-form";

export const metadata = {
  title: "Sign in · Loadless Inbox",
};

interface PageProps {
  searchParams: Promise<{ next?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  // Pre-warm Auth.js cookie context. Without this, the first signIn()
  // from a fresh browser session races with the CSRF / callback-url
  // Set-Cookie writes and corrupts the server-action RSC payload —
  // user sees "unexpected response" on the first attempt only.
  await auth();

  const { next } = await searchParams;
  const nextPath = typeof next === "string" && next.startsWith("/") ? next : "/inbox";

  return (
    <div className="grid min-h-svh place-items-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <MessageSquareText className="size-4" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">Loadless Inbox</div>
            <div className="text-[11px] text-muted-foreground">Shared WhatsApp inbox</div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <h1 className="mb-1 text-base font-semibold tracking-tight">Sign in</h1>
          <p className="mb-5 text-xs text-muted-foreground">
            Use the email your admin invited you with.
          </p>
          <LoginForm next={nextPath} />
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          New here?{" "}
          <a href="/register" className="text-primary hover:underline">
            Create a workspace
          </a>
        </p>
      </div>
    </div>
  );
}
