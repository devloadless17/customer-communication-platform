import Link from "next/link";
import { Megaphone, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { formatListTime } from "@/lib/utils";

import { BroadcastStatusBadge } from "./broadcast-status-badge";
import { BroadcastDeleteButton } from "./broadcast-delete-button";

export const metadata = { title: "Broadcasts" };
export const dynamic = "force-dynamic";

export default async function BroadcastsPage() {
  const { teamId } = await getSession();
  const rows = await db.broadcast.findMany({
    where: { teamId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { createdBy: { select: { name: true } } },
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {/* In-page tabs between Broadcasts and Groups so they read as
              two views of the same area (saved audiences + past sends). */}
          <Link
            href="/broadcasts"
            className="rounded-md bg-accent px-2.5 py-1.5 text-sm font-medium text-foreground"
          >
            Broadcasts
          </Link>
          <Link
            href="/broadcasts/groups"
            className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Groups
          </Link>
        </div>
        <Button asChild>
          <Link href="/broadcasts/new" className="gap-1.5">
            <Plus className="size-4" />
            New broadcast
          </Link>
        </Button>
      </header>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Broadcasts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Send a pre-approved WhatsApp template to many contacts in one go.
          Past broadcasts and their delivery status are listed below.
        </p>
      </div>

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Template</th>
                <th className="px-4 py-2.5 text-left font-medium">Audience</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium">Progress</th>
                <th className="px-4 py-2.5 text-left font-medium">Created</th>
                <th className="px-4 py-2.5 text-right font-medium" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr
                  key={b.id}
                  className="border-b border-border last:border-b-0 hover:bg-accent/30"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/broadcasts/${b.id}`}
                      className="font-medium text-foreground hover:text-primary"
                    >
                      {b.templateName}
                    </Link>
                    <div className="text-[11px] text-muted-foreground">
                      {b.templateLanguage} · by {b.createdBy.name}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {b.audienceMode === "all"
                      ? `All (${b.totalCount})`
                      : `${b.totalCount} selected`}
                  </td>
                  <td className="px-4 py-3">
                    <BroadcastStatusBadge status={b.status} />
                  </td>
                  <td className="px-4 py-3">
                    <ProgressBar
                      sent={b.sentCount}
                      failed={b.failedCount}
                      total={b.totalCount}
                    />
                  </td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground">
                    {formatListTime(b.createdAt.toISOString())}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <BroadcastDeleteButton
                      broadcastId={b.id}
                      templateName={b.templateName}
                      status={b.status}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center">
      <div className="inline-flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Megaphone className="size-5" />
      </div>
      <div className="text-sm font-medium">No broadcasts yet</div>
      <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
        Reach out to many contacts at once with an approved WhatsApp template.
        Each broadcast tracks per-recipient delivery so you can spot failures.
      </p>
      <Button asChild className="mt-2">
        <Link href="/broadcasts/new">Create your first broadcast</Link>
      </Button>
    </div>
  );
}

function ProgressBar({
  sent,
  failed,
  total,
}: {
  sent: number;
  failed: number;
  total: number;
}) {
  if (total === 0) {
    return <span className="text-[12px] text-muted-foreground">—</span>;
  }
  const sentPct = Math.round((sent / total) * 100);
  const failedPct = Math.round((failed / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <div className="flex h-full">
          <div className="h-full bg-emerald-500" style={{ width: `${sentPct}%` }} />
          <div className="h-full bg-destructive" style={{ width: `${failedPct}%` }} />
        </div>
      </div>
      <div className="tabular-nums text-[12px] text-muted-foreground">
        {sent + failed}/{total}
      </div>
    </div>
  );
}
