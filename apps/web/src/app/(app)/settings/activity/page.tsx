import Link from "next/link";
import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { roleLabel } from "@ccp/shared/auth/permissions";
import { getMemberStats, listTeamMembers, type StatsPeriod } from "@/lib/api/queries";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "@ccp/shared/utils";
import { cn } from "@ccp/shared/utils";
import { PageHeader } from "@/components/layouts/page-header";
import { CurrentActivityPanel } from "./current-activity-panel";

export const metadata = { title: "Activity · Settings" };
export const dynamic = "force-dynamic";

const PERIODS: { value: StatsPeriod; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "year", label: "Yearly" },
];

const WINDOW_NOTE: Record<StatsPeriod, string> = {
  all: "all time",
  day: "the last 24 hours",
  week: "the last 7 days",
  month: "the last 30 days",
  year: "the last 12 months",
};

/**
 * Per-member activity. "Active" is point-in-time (chats currently assigned);
 * Assigned / Messages sent / Closed are windowed by the selected period.
 * Gated by the `teamActivity:view` capability — the endpoint enforces it too;
 * this redirect just spares a 403 for users who reach the URL without it.
 */
export default async function TeamActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { permissions } = await getSession();
  if (!permissions["teamActivity:view"]) redirect("/settings");

  const sp = await searchParams;
  const period: StatsPeriod = PERIODS.some((p) => p.value === sp.period)
    ? (sp.period as StatsPeriod)
    : "all";

  const [stats, teamMembers] = await Promise.all([
    getMemberStats(period),
    listTeamMembers(),
  ]);
  // Member stats carry no avatarUrl (the stats endpoint is counts-only), so map
  // it in from the team roster (same cached /api/users fetch the sidebar uses).
  const avatarById = new Map(teamMembers.map((u) => [u.id, u.avatarUrl ?? null]));

  const totals = stats.reduce(
    (acc, s) => ({
      assigned: acc.assigned + s.assigned,
      messagesSent: acc.messagesSent + s.messagesSent,
      closed: acc.closed + s.closed,
    }),
    { assigned: 0, messagesSent: 0, closed: 0 },
  );

  // Seed the live panel from the same fetch (point-in-time at load); it then
  // re-polls on socket events.
  const members = stats.map((s) => ({
    userId: s.userId,
    name: s.name,
    avatarUrl: avatarById.get(s.userId) ?? null,
  }));
  const initialActive = Object.fromEntries(
    stats.map((s) => [s.userId, s.activeAssigned]),
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Team activity"
        description={
          <>
            Live current activity, plus a per-member report of assignments,
            messages sent, and chats closed over {WINDOW_NOTE[period]}.
          </>
        }
      />

      <CurrentActivityPanel members={members} initial={initialActive} />

      {/* Period selector */}
      <div className="inline-flex w-fit rounded-lg border border-border bg-muted/40 p-1">
        {PERIODS.map((p) => (
          <Link
            key={p.value}
            href={`/settings/activity?period=${p.value}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              p.value === period
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {p.label}
          </Link>
        ))}
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 text-left font-medium">Member</th>
              <th className="px-4 py-2.5 text-right font-medium">Assigned</th>
              <th className="px-4 py-2.5 text-right font-medium">Messages sent</th>
              <th className="px-4 py-2.5 text-right font-medium">Closed</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.userId} className="border-b border-border last:border-0">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <Avatar className="size-7 shrink-0">
                      {avatarById.get(s.userId) ? (
                        <AvatarImage src={avatarById.get(s.userId)!} alt={s.name} />
                      ) : null}
                      <AvatarFallback seed={s.userId} className="text-3xs">
                        {initials(s.name || s.email)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{s.name}</span>
                        {s.deactivated && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
                            deactivated
                          </span>
                        )}
                      </div>
                      <div className="truncate text-2xs text-muted-foreground">
                        {roleLabel(s.role)} · {s.email}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {s.assigned.toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {s.messagesSent.toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {s.closed.toLocaleString()}
                </td>
              </tr>
            ))}
            {stats.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  No team members yet.
                </td>
              </tr>
            )}
          </tbody>
          {stats.length > 0 && (
            <tfoot>
              <tr className="border-t border-border bg-muted/30 font-medium">
                <td className="px-4 py-2.5 text-muted-foreground">Total</td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {totals.assigned.toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {totals.messagesSent.toLocaleString()}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">
                  {totals.closed.toLocaleString()}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </section>
    </div>
  );
}
