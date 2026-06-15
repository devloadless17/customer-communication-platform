import Link from "next/link";
import {
  Building2,
  CheckCircle2,
  ChevronRight,
  Clock,
  Contact,
  MessageSquare,
  Megaphone,
  ShieldX,
  TrendingUp,
  Users,
} from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { QuickApproveButton } from "@/components/platform/team-status-actions";
import { getPlatformAnalytics } from "@/lib/api/queries";

export const metadata = { title: "Overview · Platform" };
export const dynamic = "force-dynamic";

/**
 * Super-admin Overview. Platform-wide health at a glance: org counts by
 * approval status (pending highlighted as the action surface), platform
 * totals, signup momentum, and an inline approval queue so the most common
 * action is one click from the landing page.
 */
export default async function PlatformOverviewPage() {
  const a = await getPlatformAnalytics();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-7 px-4 py-6 sm:px-6 md:px-8 md:py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Platform health across every organization.
        </p>
      </header>

      {/* Organizations by approval status. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Organizations
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Total"
            value={a.orgs.total}
            icon={<Building2 className="size-4" />}
          />
          <Link href="/platform/organizations" className="rounded-xl outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
            <StatCard
              label="Pending"
              value={a.orgs.pending}
              icon={<Clock className="size-4" />}
              tone={a.orgs.pending > 0 ? "amber" : "default"}
              hint={a.orgs.pending > 0 ? "Review →" : undefined}
            />
          </Link>
          <StatCard
            label="Active"
            value={a.orgs.active}
            icon={<CheckCircle2 className="size-4" />}
            tone="emerald"
          />
          <StatCard
            label="Suspended"
            value={a.orgs.suspended}
            icon={<ShieldX className="size-4" />}
            tone={a.orgs.suspended > 0 ? "destructive" : "default"}
          />
        </div>
      </section>

      {/* Pending approval queue — inline, actionable. */}
      {a.pendingOrgs.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Awaiting approval
            </h2>
            {a.orgs.pending > a.pendingOrgs.length && (
              <Link
                href="/platform/organizations"
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                View all {a.orgs.pending} →
              </Link>
            )}
          </div>
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
            {a.pendingOrgs.map((o) => (
              <li key={o.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  <Building2 className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/platform/organizations/${o.id}`}
                    className="truncate text-sm font-medium hover:text-primary"
                  >
                    {o.name}
                  </Link>
                  <div className="text-2xs text-muted-foreground">
                    Signed up <LocalTime iso={o.createdAt} format="listTime" />
                  </div>
                </div>
                <QuickApproveButton teamId={o.id} />
                <Link
                  href={`/platform/organizations/${o.id}`}
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Open organization"
                >
                  <ChevronRight className="size-4" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Platform totals. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          Across the platform
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="Members" value={a.totals.users} icon={<Users className="size-4" />} />
          <StatCard label="Contacts" value={a.totals.contacts} icon={<Contact className="size-4" />} />
          <StatCard
            label="Conversations"
            value={a.totals.conversations}
            icon={<MessageSquare className="size-4" />}
          />
          <StatCard
            label="Messages"
            value={a.totals.messages}
            icon={<MessageSquare className="size-4" />}
          />
          <StatCard
            label="Broadcasts"
            value={a.totals.broadcasts}
            icon={<Megaphone className="size-4" />}
          />
          <StatCard
            label="New (30d)"
            value={a.newOrgsLast30d}
            icon={<TrendingUp className="size-4" />}
          />
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone = "default",
  hint,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  tone?: "default" | "amber" | "emerald" | "destructive";
  hint?: string;
}) {
  const toneClass = {
    default: "text-muted-foreground",
    amber: "text-amber-600 dark:text-amber-400",
    emerald: "text-emerald-600 dark:text-emerald-400",
    destructive: "text-destructive",
  }[tone];
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5 transition-colors hover:bg-accent/30">
      <div className="flex items-center justify-between">
        <span className={toneClass}>{icon}</span>
        {hint && <span className="text-2xs font-medium text-amber-600 dark:text-amber-400">{hint}</span>}
      </div>
      <div>
        <div className="tabular-nums text-2xl font-semibold">{value}</div>
        <div className="text-[12px] text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}
