import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, LogIn, ShieldX, Users, X } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { LocalTime } from "@/components/local-time";
import { OrgStatusBadge } from "@/components/platform/org-status-badge";
import { OrgStatusControls } from "@/components/platform/org-status-actions";
import { getSession } from "@/lib/auth/current-user";
import { getWorkspaceDetailForSuperAdmin, listOperatorAccess } from "@/lib/api/queries";
import { soft } from "@/lib/api/soft";
import { roleLabel } from "@ccp/shared/auth/permissions";
import { cn, formatPhone, initials } from "@ccp/shared/utils";

import { DeleteOrganizationButton } from "./delete-organization-button";
import { EnterWorkspaceButton } from "./enter-workspace-button";
import { LimitControl } from "./limit-control";

export const metadata = { title: "Organization · Platform" };
export const dynamic = "force-dynamic";

/**
 * Org detail for the super-admin. Member roster + headline counts + approval
 * controls (approve / suspend / reactivate), and the one audited door into the
 * tenant's actual workspace.
 *
 * The page's own reads stop at aggregates and the roster — never a message body
 * or a contact name (see the invariant in lib/queries/super-admin.ts). Reaching
 * the inbox is a SEPARATE, deliberate act: "Enter workspace" writes an
 * `OperatorAccess` row and re-scopes the session, and every entry it has ever
 * recorded is listed further down this page. This used to say we don't expose
 * the inbox at all; operator mode replaced that with exposing it on the record.
 */
export default async function PlatformOrganizationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, session] = await Promise.all([
    getWorkspaceDetailForSuperAdmin(id),
    getSession(),
  ]);
  if (!detail) notFound();

  // Best-effort: the audit panel is a read ABOUT the management surface, so a
  // failure there must not take the management surface down. Fetched after the
  // 404 gate because it needs the organization id off the detail.
  const accessLog = await soft("operator-access log", [], () =>
    listOperatorAccess(detail.workspace.organizationId),
  );

  const { workspace, members } = detail;
  // Compared on the ORGANIZATION, not the workspace: both controls it gates
  // (delete, approve/suspend) act on the whole org, and the API refuses them
  // org-wide. Matching on workspace id offered an operator a Delete button for
  // a SIBLING workspace of their own org that the server then rejected.
  const isOwnOrg = workspace.organizationId === session.organizationId;
  const activeMembers = members.filter((m) => !m.deactivatedAt);
  const deactivatedMembers = members.filter((m) => m.deactivatedAt);
  // Member-cap seats = active, non-superAdmin users IN THIS WORKSPACE (a
  // platform operator co-located into an org doesn't consume a seat — mirrors
  // the API count). `inWorkspace` is load-bearing here: the roster is now
  // org-wide, so without it an org member who hasn't joined this workspace
  // would be counted against a cap they don't consume, and the "N / max"
  // display would read as full while invites still succeed.
  const memberSeatCount = activeMembers.filter(
    (m) => m.inWorkspace && !m.isSuperAdmin,
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
        <div className="flex items-start gap-2">
          <EnterWorkspaceButton
            workspaceId={workspace.id}
            workspaceName={workspace.name}
            orgName={workspace.name}
            isOwnOrg={isOwnOrg}
          />
          <DeleteOrganizationButton
            organizationId={workspace.organizationId}
            orgName={workspace.name}
            isOwnOrg={isOwnOrg}
          />
        </div>
      </div>

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{workspace.name}</h1>
          <OrgStatusBadge status={workspace.status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{workspace.id}</span>
          <span>·</span>
          <span>
            Created <LocalTime iso={workspace.createdAt} format="listTime" />
          </span>
          <span>·</span>
          {/* ORGANISATION-level cap: how many workspaces it may create. The
              seat cap next to the member list is per-WORKSPACE. */}
          <LimitControl
            workspaceId={workspace.id}
            max={workspace.maxWorkspaces}
            used={workspace.workspaceCount ?? 0}
            endpoint="max-workspaces"
            bodyKey="maxWorkspaces"
            noun="workspace"
            label="Workspaces"
            hardMax={100}
          />
          <span>·</span>
          {workspace.whatsappConnected ? (
            <span className="inline-flex items-center gap-1 text-success-fg">
              <CheckCircle2 className="size-3.5" />
              {workspace.whatsappDisplayNumber
                ? formatPhone(workspace.whatsappDisplayNumber)
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
          <p className="text-xs text-muted-foreground">
            {workspace.status === "pending" &&
              "This organization is waiting for approval — its members can't use the app yet."}
            {workspace.status === "active" &&
              "This organization is approved and has full access to the app."}
            {workspace.status === "suspended" &&
              "This organization is suspended — its members are locked out until reactivated."}
          </p>
          {workspace.statusReason && (
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Reason:</span>{" "}
              {workspace.statusReason}
            </p>
          )}
          {workspace.statusUpdatedAt && (
            <p className="text-2xs text-muted-foreground/80">
              Last changed <LocalTime iso={workspace.statusUpdatedAt} format="listTime" />
            </p>
          )}
        </div>
        <OrgStatusControls
          organizationId={workspace.organizationId}
          status={workspace.status}
          isOwnOrg={isOwnOrg}
        />
      </section>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Members" value={workspace.userCount} />
        <Stat label="Contacts" value={workspace.contactCount} />
        <Stat label="Chats" value={workspace.conversationCount} />
        <Stat label="Messages" value={workspace.messageCount} />
        <Stat label="Broadcasts" value={workspace.broadcastCount} />
      </section>

      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <div className="text-sm font-semibold">Members</div>
            {deactivatedMembers.length > 0 && (
              <span className="text-2xs text-muted-foreground">
                · {deactivatedMembers.length} deactivated
              </span>
            )}
          </div>
          {/* Seat cap is per WORKSPACE; the workspace cap is per ORGANISATION.
              Both are super-admin controlled and both default to 2. */}
          <LimitControl
            workspaceId={workspace.id}
            max={workspace.maxMembers}
            used={memberSeatCount}
            endpoint="max-members"
            bodyKey="maxMembers"
            noun="member"
            label="Limit"
          />
        </header>
        {members.length === 0 ? (
          <div className="px-6 py-8 text-center text-xs text-muted-foreground">
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
                  <AvatarFallback seed={m.id} className="text-3xs">
                    {initials(m.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{m.name}</span>
                    {/* The roster is ORG-wide, so it includes people who belong
                        to no workspace (a half-finished signup, an unaccepted
                        invite). Showing a workspace role for them would assert
                        access they don't have — show the org role and say so. */}
                    {m.inWorkspace ? (
                      <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-3xs uppercase text-muted-foreground">
                        {roleLabel(m.role)}
                      </span>
                    ) : (
                      <span
                        className="rounded-full border border-dashed border-border px-1.5 py-0.5 text-3xs uppercase text-muted-foreground"
                        title="In the organization, but not a member of this workspace"
                      >
                        Org {m.orgRole} · no workspace access
                      </span>
                    )}
                    {m.deactivatedAt && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-warning-border bg-warning-bg px-1.5 py-0.5 text-3xs text-warning-fg">
                        <ShieldX className="size-2.5" />
                        Deactivated
                      </span>
                    )}
                  </div>
                  <div className="truncate text-2xs text-muted-foreground">
                    {m.email}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="hidden text-2xs text-muted-foreground sm:inline">
                    Joined <LocalTime iso={m.createdAt} format="listTime" />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* OPERATOR ACCESS LOG. Append-only, newest first, and deliberately on the
          same page as the button that writes it — an audit trail filed somewhere
          else is one nobody reads. Every crossing into this organization, not
          just this workspace. */}
      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-center justify-between gap-3 border-b border-border bg-muted/30 px-4 py-3">
          <div className="text-sm font-semibold">Operator access</div>
          <span className="text-2xs text-muted-foreground">
            {accessLog.length === 0
              ? "Never entered"
              : `${accessLog.length} recent ${accessLog.length === 1 ? "entry" : "entries"}`}
          </span>
        </header>
        {accessLog.length === 0 ? (
          <div className="px-6 py-8 text-center text-xs text-muted-foreground">
            No platform operator has entered this organization&apos;s workspaces.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {accessLog.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 px-4 py-2.5">
                <LogIn aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">
                    {/* Null when the account has since been deleted — the row
                        outlives it on purpose, so show the id rather than
                        pretending the visit didn't happen. */}
                    <span className="font-medium">
                      {entry.operatorName ?? entry.userId}
                    </span>
                    <span className="text-muted-foreground">
                      {" "}
                      {operatorActionLabel(entry.action)}{" "}
                      {entry.workspaceName ?? "a deleted workspace"}
                      {detailSuffix(entry.detail)}
                    </span>
                  </div>
                  {entry.operatorEmail && (
                    <div className="truncate text-2xs text-muted-foreground">
                      {entry.operatorEmail}
                    </div>
                  )}
                </div>
                <span className="shrink-0 text-2xs text-muted-foreground">
                  <LocalTime iso={entry.createdAt} format="listTime" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex items-center gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-2xs text-warning-fg">
        <Users className="size-3.5 shrink-0" />
        <span>
          Platform-admin view: members and aggregate counts only — conversations
          and message bodies stay private to each workspace. Reaching them means
          entering the workspace, which is recorded above.
        </span>
      </div>
    </div>
  );
}

/** The log's verb, per recorded action -- reads as a sentence with the
 *  workspace name that follows ("Ali sent a broadcast in Acme Support"). */
function operatorActionLabel(action: string): string {
  switch (action) {
    case "broadcast_send":
      return "sent a broadcast in";
    case "api_key_create":
      return "created an API key in";
    case "outbound_webhook_create":
      return "created an outbound webhook in";
    case "contact_export":
      return "exported contacts from";
    default:
      return "entered";
  }
}

/** One short parenthetical from the writer-shaped detail, when it names
 *  something a human would recognize. */
function detailSuffix(detail: Record<string, unknown> | null): string {
  if (!detail) return "";
  const named = detail.name ?? detail.url ?? detail.rotatedKeyId;
  return typeof named === "string" && named.length > 0 ? ` (${named})` : "";
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 tabular-nums text-2xl font-semibold">{value}</div>
    </div>
  );
}
