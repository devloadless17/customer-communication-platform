import { MessageSquareText } from "lucide-react";

import { db } from "@/lib/db";
import { hashInviteToken } from "@/lib/auth/invite-token";
import { roleLabel } from "@/lib/auth/permissions";

import { AcceptForm } from "./accept-form";

export const metadata = {
  title: "Accept invite · Loadless Inbox",
};

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function AcceptInvitePage({ params }: PageProps) {
  const { token } = await params;

  const invite = await db.invite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    select: {
      email: true,
      role: true,
      acceptedAt: true,
      expiresAt: true,
      team: { select: { name: true } },
    },
  });

  if (!invite) return <Shell title="Invalid link">This invite link doesn&apos;t exist.</Shell>;
  if (invite.acceptedAt) {
    return <Shell title="Already accepted">This invite has already been used.</Shell>;
  }
  if (invite.expiresAt < new Date()) {
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

        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <h1 className="mb-1 text-base font-semibold tracking-tight">
            Join {invite.team.name}
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
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm">
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
