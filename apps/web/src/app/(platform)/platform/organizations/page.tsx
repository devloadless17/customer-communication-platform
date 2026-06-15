import Link from "next/link";
import { Building2, CheckCircle2, ChevronRight, Clock, Phone, X } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { TeamStatusBadge } from "@/components/platform/team-status-badge";
import { QuickApproveButton } from "@/components/platform/team-status-actions";
import { listAllTeamsForSuperAdmin } from "@/lib/api/queries";
import { formatPhone } from "@ccp/shared/utils";
import type { TeamStatus } from "@ccp/shared/types";

export const metadata = { title: "Organizations · Platform" };
export const dynamic = "force-dynamic";

const STATUS_ORDER: Record<TeamStatus, number> = {
  pending: 0,
  active: 1,
  suspended: 2,
};

/**
 * Platform Organizations. Every org on the platform with its approval status,
 * aggregate counts, and WhatsApp-connected state. Pending orgs float to the top
 * (the approval queue) with a one-click Approve; click any row for full detail
 * + suspend / reactivate controls.
 */
export default async function PlatformOrganizationsPage() {
  const teams = await listAllTeamsForSuperAdmin();
  // Stable sort keeps each status group in the query's createdAt-asc order, so
  // the pending queue is oldest-waiting-first.
  const sorted = [...teams].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  );
  const pendingCount = teams.filter((t) => t.status === "pending").length;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 md:px-8 md:py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every team on the platform.{" "}
            <span className="tabular-nums">{teams.length}</span> total.
          </p>
        </div>
        {pendingCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warning-border bg-warning-bg px-3 py-1 text-[13px] font-medium text-warning-fg">
            <Clock className="size-3.5" />
            {pendingCount} awaiting approval
          </span>
        )}
      </header>

      {teams.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center">
          <Building2 className="size-6 text-muted-foreground" />
          <div className="text-sm font-medium">No organizations yet</div>
          <p className="text-[12px] text-muted-foreground">
            They appear here as soon as the first team gets created.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-200 text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-2xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Organization</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium">WhatsApp</th>
                <th className="px-4 py-2.5 text-right font-medium">Members</th>
                <th className="px-4 py-2.5 text-right font-medium">Contacts</th>
                <th className="px-4 py-2.5 text-right font-medium">Chats</th>
                <th className="px-4 py-2.5 text-right font-medium">Messages</th>
                <th className="px-4 py-2.5 text-left font-medium">Created</th>
                <th className="px-4 py-2.5 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-border last:border-b-0 hover:bg-accent/30"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/platform/organizations/${t.id}`}
                      className="font-medium text-foreground hover:text-primary"
                    >
                      {t.name}
                    </Link>
                    <div className="font-mono text-2xs text-muted-foreground">
                      {t.id}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <TeamStatusBadge status={t.status} />
                  </td>
                  <td className="px-4 py-3">
                    {t.whatsappConnected ? (
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-success-fg">
                        <CheckCircle2 className="size-3.5" />
                        {t.whatsappDisplayNumber ? (
                          <span className="font-mono">
                            {formatPhone(t.whatsappDisplayNumber)}
                          </span>
                        ) : (
                          "Connected"
                        )}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground">
                        <X className="size-3.5" />
                        Not connected
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.userCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {t.contactCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {t.conversationCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {t.messageCount}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground">
                    <LocalTime iso={t.createdAt} format="listTime" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {t.status === "pending" && <QuickApproveButton teamId={t.id} />}
                      <Link
                        href={`/platform/organizations/${t.id}`}
                        className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label="Open organization"
                      >
                        <ChevronRight className="size-4" />
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-2xs text-muted-foreground">
        <Phone className="mr-1 inline size-3" />
        Phone numbers shown are the WhatsApp Business numbers each team has connected.
      </p>
    </div>
  );
}
