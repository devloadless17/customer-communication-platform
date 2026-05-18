import { cookies } from "next/headers";
import { MessageSquareText } from "lucide-react";

import { lookupInvite } from "@/lib/api/queries";
import { roleLabel } from "@ccp/shared/auth/permissions";

import { AcceptForm } from "./accept-form";
import { INVITE_JUST_ACCEPTED_COOKIE } from "./actions";
import { RedirectToInbox } from "./redirect-to-inbox";

export const metadata = {
  title: "Accept invite · Loadless Inbox",
};

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function AcceptInvitePage({ params }: PageProps) {
  const { token } = await params;
  const { status, invite } = await lookupInvite(token);

  if (status === "invalid" || !invite) {
    return <Shell title="Invalid link">This invite link doesn&apos;t exist.</Shell>;
  }
  if (status === "used") {
    // Server actions auto-revalidate the route they were called from. After
    // a successful accept the page re-renders here with `status === "used"`
    // — which unmounts AcceptForm before its router.replace effect can fire.
    // The accept action sets a short-lived cookie keyed to this token so we
    // can tell "this browser just accepted" from "stale visitor on a used
    // link" without depending on the session cookie (which isn't visible in
    // headers() on the same-request revalidation). Just-accepters navigate
    // in a fresh client subtree that survives the refresh; stale visitors
    // still see the "go to sign in" Shell.
    const justAccepted =
      (await cookies()).get(INVITE_JUST_ACCEPTED_COOKIE)?.value === token;
    if (justAccepted) {
      return <RedirectToInbox />;
    }
    return <Shell title="Already accepted">This invite has already been used.</Shell>;
  }
  if (status === "expired") {
    return (
      <Shell title="Invite expired">
        Ask your admin to send you a new link.
      </Shell>
    );
  }

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

        <div className="rounded-xl border border-border bg-card p-6 shadow-xs">
          <h1 className="mb-1 text-base font-semibold tracking-tight">
            Join {invite.teamName}
          </h1>
          <p className="mb-5 text-xs text-muted-foreground">
            You&apos;ve been invited as a{" "}
            <span className="font-medium text-foreground">{roleLabel(invite.role)}</span>.
            Set a password to continue.
          </p>
          <AcceptForm token={token} email={invite.email} />
        </div>
      </div>
    </div>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-svh place-items-center bg-background px-4 text-center">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-xs">
        <h1 className="mb-2 text-base font-semibold tracking-tight">{title}</h1>
        <p className="text-xs text-muted-foreground">{children}</p>
        <a
          href="/login"
          className="mt-4 inline-block text-xs text-primary hover:underline"
        >
          Go to sign in
        </a>
      </div>
    </div>
  );
}
