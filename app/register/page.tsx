import Link from "next/link";
import { MessageSquareText } from "lucide-react";

import { auth } from "@/lib/auth";

import { RegisterForm } from "./register-form";

export const metadata = {
  title: "Create account · Loadless Inbox",
};

export default async function RegisterPage() {
  // Pre-warm Auth.js cookie context — same rationale as app/login/page.tsx.
  await auth();

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
          <h1 className="mb-1 text-base font-semibold tracking-tight">
            Create your workspace
          </h1>
          <p className="mb-5 text-xs text-muted-foreground">
            You&apos;ll be the admin of your team. Connect your WhatsApp number after
            sign-up — that takes about 5 minutes.
          </p>
          <RegisterForm />
        </div>

        <p className="mt-4 text-center text-[11px] text-muted-foreground">
          Already have an account?{" "}
          <Link href="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
