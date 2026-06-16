import { redirect } from "next/navigation";
import { Clock, ShieldAlert } from "lucide-react";

import { getSession } from "@/lib/auth/current-user";
import { db } from "@/lib/db";

import { PendingActions } from "./pending-actions";

export const metadata = { title: "Awaiting approval" };
export const dynamic = "force-dynamic";

/**
 * Org-approval gate screen. Lives OUTSIDE the (app) route group so a locked-out
 * org can actually reach it (the (app) layout redirects every pending/suspended
 * org here). Shown to a member of a `pending` org (awaiting super-admin review)
 * or a `suspended` org (access revoked).
 *
 * Self-heals: superAdmins are sent to /platform, and an org that has since been
 * approved (`active`) is forwarded straight to /settings/whatsapp — the
 * client island also polls so approval lets the user in without a manual reload.
 */
export default async function PendingPage() {
  const { user, teamId, teamStatus } = await getSession();

  // superAdmins never sit here — they manage from the platform shell.
  if (user.role === "superAdmin") redirect("/platform");
  // Approved already (e.g. approved between page loads) → into the app.
  if (teamStatus === "active") redirect("/settings/whatsapp");

  const team = await db.team.findUnique({
    where: { id: teamId },
    select: { name: true, statusReason: true },
  });

  const suspended = teamStatus === "suspended";

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center gap-5 rounded-2xl border border-border bg-card px-6 py-9 text-center shadow-sm sm:px-9">
          <span
            className={
              suspended
                ? "flex size-14 items-center justify-center rounded-full bg-destructive/10 text-destructive"
                : "flex size-14 items-center justify-center rounded-full bg-warning-bg text-warning-fg"
            }
          >
            {suspended ? (
              <ShieldAlert className="size-7" />
            ) : (
              <Clock className="size-7" />
            )}
          </span>

          <div className="flex flex-col gap-2">
            <h1 className="text-xl font-semibold tracking-tight">
              {suspended
                ? "Your organization is suspended"
                : "Your organization is awaiting approval"}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {suspended ? (
                <>
                  Access to{" "}
                  <span className="font-medium text-foreground">
                    {team?.name ?? "your workspace"}
                  </span>{" "}
                  has been paused. Reach out to support to get it restored.
                </>
              ) : (
                <>
                  Thanks for signing up,{" "}
                  <span className="font-medium text-foreground">{user.name}</span>.{" "}
                  <span className="font-medium text-foreground">
                    {team?.name ?? "Your workspace"}
                  </span>{" "}
                  is in the review queue. We&rsquo;ll let you in automatically the
                  moment it&rsquo;s approved.
                </>
              )}
            </p>
          </div>

          {team?.statusReason ? (
            <div className="w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-[13px] text-muted-foreground">
              <span className="font-medium text-foreground">Note from the team:</span>{" "}
              {team.statusReason}
            </div>
          ) : null}

          <PendingActions />
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Signed in as {user.email}
        </p>
      </div>
    </main>
  );
}
