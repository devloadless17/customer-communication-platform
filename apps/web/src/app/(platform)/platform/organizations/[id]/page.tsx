import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, ShieldX, Users, X } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LocalTime } from "@/components/local-time";
import { TeamStatusBadge } from "@/components/platform/team-status-badge";
import { TeamStatusControls } from "@/components/platform/team-status-actions";
import { getSession } from "@/lib/auth/current-user";
import { getTeamDetailForSuperAdmin } from "@/lib/api/queries";
import { roleLabel } from "@ccp/shared/auth/permissions";
import { cn, formatPhone, initials } from "@ccp/shared/utils";

import { DeleteTeamButton } from "./delete-team-button";
import { MaxMembersControl } from "./max-members-control";
import { MemberResetPasswordButton } from "./member-reset-password-button";

export const metadata = { title: "Organization · Platform" };
export const dynamic = "force-dynamic";

/**
 * Org detail for the super-admin. Member roster + headline counts +
 * approval controls (approve / suspend / reactivate). We intentionally DON'T
 * expose the inbox itself — this is a visibility + management layer, not a
 * support-impersonation tool.
 */
export default async function PlatformOrganizationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, session] = await Promise.all([
    getTeamDetailForSuperAdmin(id),
    getSession(),
  ]);
  if (!detail) notFound();

  const { team, members } = detail;
  const isOwnTeam = team.id === session.teamId;
  const activeMembers = members.filter((m) => !m.deactivatedAt);
  const deactivatedMembers = members.filter((m) => m.deactivatedAt);
  // Member-cap seats = active, non-superAdmin users (a platform operator
  // co-located into an org doesn't consume a seat — mirrors the API count).
  const memberSeatCount = activeMembers.filter(
    (m) => m.role !== "superAdmin",
  ).length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 md:px-8 md:py-8">
      <div className="flex items-center justify-between">
        <Link
          href="/platform/organizations"
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          All organizations
        </Link>
        <DeleteTeamButton
          teamId={team.id}
          teamName={team.name}
          isOwnTeam={isOwnTeam}
        />
      </div>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1>
          <TeamStatusBadge status={team.status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          <span className="font-mono">{team.id}</span>
          <span>·</span>
          <span>
            Created <LocalTime iso={team.createdAt} format="listTime" />
          </span>
          <span>·</span>
          {team.whatsappConnected ? (
            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="size-3.5" />
              {team.whatsappDisplayNumber
                ? formatPhone(team.whatsappDisplayNumber)
                : "WhatsApp connected"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <X className="size-3.5" />
              WhatsApp not connected
            </span>
          )}
        </div>
      </header>

      {/* Approval / access controls. */}
      <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-sm font-semibold">Access</div>
          <p className="text-[12px] text-muted-foreground">
            {team.status === "pending" &&
              "This organization is waiting for approval — its members can't use the app yet."}
            {team.status === "active" &&
              "This organization is approved and has full access to the app."}
            {team.status === "suspended" &&
              "This organization is suspended — its members are locked out until reactivated."}
          </p>
          {team.statusReason && (
            <p className="mt-1 text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground">Reason:</span>{" "}
              {team.statusReason}
            </p>
          )}
          {team.statusUpdatedAt && (
            <p className="text-[11px] text-muted-foreground/80">
              Last changed <LocalTime iso={team.statusUpdatedAt} format="listTime" />
            </p>
          )}
        </div>
        <TeamStatusControls
          teamId={team.id}
          status={team.status}
          isOwnTeam={isOwnTeam}
        />
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Members" value={team.userCount} />
        <Stat label="Contacts" value={team.contactCount} />
        <Stat label="Chats" value={team.conversationCount} />
        <Stat label="Messages" value={team.messageCount} />
        <Stat label="Broadcasts" value={team.broadcastCount} />
      </section>

      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <div className="text-sm font-semibold">Members</div>
            {deactivatedMembers.length > 0 && (
              <span className="text-[11px] text-muted-foreground">
                · {deactivatedMembers.length} deactivated
              </span>
            )}
          </div>
          <MaxMembersControl
            teamId={team.id}
            maxMembers={team.maxMembers}
            activeMembers={memberSeatCount}
          />
        </header>
        {members.length === 0 ? (
          <div className="px-6 py-8 text-center text-[12px] text-muted-foreground">
            No members yet.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {members.map((m) => (
              <li
                key={m.id}
                className={cn(
                  "flex items-center gap-3 px-4 py-3",
                  m.deactivatedAt && "opacity-60",
                )}
              >
                <Avatar className="size-8 shrink-0">
                  <AvatarFallback seed={m.id} className="text-[10px]">
                    {initials(m.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{m.name}</span>
                    <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                      {roleLabel(m.role)}
                    </span>
                    {m.deactivatedAt && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                        <ShieldX className="size-2.5" />
                        Deactivated
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {m.email}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="hidden text-[11px] text-muted-foreground sm:inline">
                    Joined <LocalTime iso={m.createdAt} format="listTime" />
                  </span>
                  {m.id !== session.user.id && (
                    <MemberResetPasswordButton
                      teamId={team.id}
                      userId={m.id}
                      name={m.name}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
        <Users className="size-3.5 shrink-0" />
        <span>
          Platform-admin view. Members and aggregate counts only — conversations
          and message bodies stay private to each team.
        </span>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 tabular-nums text-2xl font-semibold">{value}</div>
    </div>
  );
}
