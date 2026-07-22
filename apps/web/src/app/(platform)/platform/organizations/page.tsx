import Link from "next/link";
import { Building2, CheckCircle2, ChevronRight, Clock, Phone, X } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { TeamStatusBadge } from "@/components/platform/team-status-badge";
import { QuickApproveButton } from "@/components/platform/team-status-actions";
import { listAllOrgsForSuperAdmin } from "@/lib/api/queries";
import { formatPhone } from "@ccp/shared/utils";
import type { OrgStatus } from "@ccp/shared/types";

export const metadata = { title: "Organizations · Platform" };
export const dynamic = "force-dynamic";

const STATUS_ORDER: Record<OrgStatus, number> = {
  pending: 0,
  active: 1,
  suspended: 2,
};

/**
 * Platform Organizations — ORGANISATIONS, each with the workspaces it owns.
 *
 * This page used to list WORKSPACES under an "Organizations" heading: it showed
 * workspace ids, and a customer with two workspaces appeared as two separate
 * customers. Approval status, the workspace cap and the commercial relationship
 * all live on the ORGANISATION, so that is the row; workspaces nest beneath it
 * with their own channel + activity counts.
 *
 * Pending orgs float to the top (the approval queue) with a one-click Approve.
 */
export default async function PlatformOrganizationsPage() {
  const orgs = await listAllOrgsForSuperAdmin();
  // Stable sort keeps each status group in the query's createdAt-asc order, so
  // the pending queue is oldest-waiting-first.
  const sorted = [...orgs].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  );
  const pendingCount = orgs.filter((o) => o.status === "pending").length;
  const workspaceTotal = orgs.reduce((n, o) => n + o.workspaces.length, 0);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 md:px-8 md:py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Organizations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            <span className="tabular-nums">{orgs.length}</span> organization
            {orgs.length === 1 ? "" : "s"} ·{" "}
            <span className="tabular-nums">{workspaceTotal}</span> workspace
            {workspaceTotal === 1 ? "" : "s"}.
          </p>
        </div>
        {pendingCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-warning-border bg-warning-bg px-3 py-1 text-[13px] font-medium text-warning-fg">
            <Clock className="size-3.5" />
            {pendingCount} awaiting approval
          </span>
        )}
      </header>

      {orgs.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center">
          <Building2 className="size-6 text-muted-foreground" />
          <div className="text-sm font-medium">No organizations yet</div>
          <p className="text-xs text-muted-foreground">
            They appear here as soon as someone signs up.
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
            {/* One tbody per organisation: the org summary row, then a row per
                workspace it owns. Grouping by tbody (rather than one flat list)
                is what lets the indent read as containment instead of as a
                second, unrelated table. */}
            {sorted.map((o) => (
              <tbody key={o.id} className="border-b border-border last:border-b-0">
                <tr className="bg-muted/10 hover:bg-accent/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Building2 className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium text-foreground">{o.name}</span>
                    </div>
                    <div className="pl-5.5 font-mono text-2xs text-muted-foreground">
                      {o.id}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <TeamStatusBadge status={o.status} />
                  </td>
                  <td className="px-4 py-3 text-2xs text-muted-foreground">
                    {o.workspaces.length} / {o.maxWorkspaces} workspace
                    {o.maxWorkspaces === 1 ? "" : "s"}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{o.memberCount}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {o.contactCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {o.conversationCount}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {o.messageCount}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    <LocalTime iso={o.createdAt} format="listTime" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {o.status === "pending" && o.workspaces[0] && (
                        <QuickApproveButton workspaceId={o.workspaces[0].id} />
                      )}
                    </div>
                  </td>
                </tr>

                {o.workspaces.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-4 pb-3 pl-11 text-2xs text-muted-foreground"
                    >
                      No workspaces yet.
                    </td>
                  </tr>
                ) : (
                  o.workspaces.map((w) => (
                    <tr key={w.id} className="hover:bg-accent/30">
                      <td className="py-2.5 pl-11 pr-4">
                        <Link
                          href={`/platform/organizations/${w.id}`}
                          className="text-foreground hover:text-primary"
                        >
                          {w.name}
                        </Link>
                        <div className="font-mono text-3xs text-muted-foreground">
                          {w.id}
                        </div>
                      </td>
                      <td className="px-4 py-2.5" />
                      <td className="px-4 py-2.5">
                        {w.whatsappConnected ? (
                          <span className="inline-flex items-center gap-1.5 text-xs text-success-fg">
                            <CheckCircle2 className="size-3.5" />
                            {w.whatsappDisplayNumber ? (
                              <span className="font-mono">
                                {formatPhone(w.whatsappDisplayNumber)}
                              </span>
                            ) : (
                              "Connected"
                            )}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <X className="size-3.5" />
                            Not connected
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs tabular-nums text-muted-foreground">
                        {w.userCount} / {w.maxMembers}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs tabular-nums text-muted-foreground">
                        {w.contactCount}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs tabular-nums text-muted-foreground">
                        {w.conversationCount}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs tabular-nums text-muted-foreground">
                        {w.messageCount}
                      </td>
                      <td className="px-4 py-2.5 text-2xs text-muted-foreground">
                        <LocalTime iso={w.createdAt} format="listTime" />
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end">
                          <Link
                            href={`/platform/organizations/${w.id}`}
                            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={`Open workspace ${w.name}`}
                          >
                            <ChevronRight className="size-4" />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            ))}
          </table>
        </div>
      )}

      <p className="text-2xs text-muted-foreground">
        <Phone className="mr-1 inline size-3" />
        Workspaces are indented under the organization that owns them. Phone
        numbers are the WhatsApp Business number each workspace has connected.
      </p>
    </div>
  );
}
