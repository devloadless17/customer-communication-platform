import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  ShieldX,
  Users,
  X,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LocalTime } from "@/components/local-time";
import { getSession } from "@/lib/auth/current-user";
import { getTeamDetailForSuperAdmin } from "@/lib/api/queries";
import { roleLabel } from "@ccp/shared/auth/permissions";
import { formatListTime, formatPhone, initials } from "@ccp/shared/utils";
import { cn } from "@ccp/shared/utils";

import { DeleteTeamButton } from "./delete-team-button";

export const metadata = { title: "Organization · Admin" };
export const dynamic = "force-dynamic";

/**
 * Read-only team detail for the platform admin. Shows the full member
 * roster + last 20 conversations + headline counts. We intentionally
 * DON'T expose the inbox itself from here — superAdmin browsing isn't a
 * support-impersonation tool, just a visibility layer. If you need that,
 * it's a separate audit-logged feature.
 */
export default async function AdminTeamDetailPage({
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
  const activeMembers = members.filter((m) => !m.deactivatedAt);
  const deactivatedMembers = members.filter((m) => m.deactivatedAt);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-8">
      <div className="flex items-center justify-between">
        <Link
          href="/admin"
          className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          All organizations
        </Link>
        <DeleteTeamButton
          teamId={team.id}
          teamName={team.name}
          isOwnTeam={team.id === session.teamId}
        />
      </div>

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          <span className="font-mono">{team.id}</span>
          <span>·</span>
          <span>Created <LocalTime iso={team.createdAt} format={formatListTime} /></span>
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

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Members" value={team.userCount} />
        <Stat label="Contacts" value={team.contactCount} />
        <Stat label="Chats" value={team.conversationCount} />
        <Stat label="Messages" value={team.messageCount} />
        <Stat label="Broadcasts" value={team.broadcastCount} />
      </section>

      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-center justify-between border-b border-border bg-muted/30 px-4 py-3">
          <div className="text-sm font-semibold">Members</div>
          <div className="text-[11px] text-muted-foreground">
            {activeMembers.length} active
            {deactivatedMembers.length > 0
              ? ` · ${deactivatedMembers.length} deactivated`
              : ""}
          </div>
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
                  <AvatarFallback className="text-[10px]">
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
                <div className="text-[11px] text-muted-foreground">
                  Joined <LocalTime iso={m.createdAt} format={formatListTime} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
        <Users className="size-3.5 shrink-0" />
        <span>
          Platform-admin view. Members and aggregate counts only —
          conversations and message bodies stay private to each team.
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
