import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus, Workflow } from "lucide-react";

import { LocalTime } from "@/components/local-time";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth/current-user";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { listWorkflows } from "@/lib/api/queries";

export const metadata = { title: "Workflows" };
export const dynamic = "force-dynamic";

const TRIGGER_LABELS: Record<string, string> = {
  message_received: "Message received",
  conversation_created: "Conversation created",
  conversation_opened: "Conversation opened",
  conversation_closed: "Conversation closed",
  conversation_assigned: "Conversation assigned",
  conversation_status_changed: "Status changed",
  contact_field_updated: "Contact field updated",
  contact_tag_updated: "Contact tag updated",
  contact_lifecycle_updated: "Lifecycle updated",
  manual_trigger: "Manual trigger",
  incoming_webhook: "Incoming webhook",
};

export default async function WorkflowsPage() {
  const { user } = await getSession();
  const canManage = canManageUsers(user.role);
  // Workflows are admin-only: GET /api/team/workflows is @RequireRole("admin"),
  // so a non-admin reaching this page would hit a 403 from listWorkflows() and
  // land on a generic "Workflows failed to load" error boundary. Redirect to a
  // page they can use instead — mirroring the new/[id] sub-pages' own guards.
  // The rail icon is already filtered out for them (app-rail.tsx); this covers
  // a direct URL / stale link.
  if (!canManage) {
    redirect("/inbox");
  }

  const rows = await listWorkflows();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 md:py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Workflows</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Multi-step workflows triggered by inbox or contact events. Drag steps onto the canvas,
            connect them, publish.
          </p>
        </div>
        {canManage && (
          <Button asChild>
            <Link href="/workflows/new">
              <Plus className="size-4" />
              New workflow
            </Link>
          </Button>
        )}
      </header>

      {rows.length === 0 ? (
        <EmptyState canManage={canManage} />
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {rows.map((r) => {
            const stepCount = r.stepCount;
            return (
              <Link
                key={r.id}
                href={`/workflows/${r.id}`}
                className="flex items-center gap-4 px-4 py-3 hover:bg-accent/30"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Workflow className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{r.name}</span>
                    {r.published ? (
                      <span className="rounded-full bg-success-bg px-2 py-0.5 text-3xs font-medium uppercase tracking-wide text-success-fg">
                        Live
                      </span>
                    ) : (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                        Draft
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-2xs text-muted-foreground">
                    {TRIGGER_LABELS[r.trigger] ?? r.trigger} · {stepCount} step{stepCount === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="hidden flex-col items-end gap-0.5 text-right text-2xs text-muted-foreground sm:flex">
                  <div>{r.runCount} run{r.runCount === 1 ? "" : "s"}</div>
                  <div><LocalTime iso={r.createdAt} format="listTime" /></div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmptyState({ canManage }: { canManage: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-muted/20 px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Workflow className="size-5" />
      </div>
      <div>
        <div className="text-sm font-medium">No workflows yet</div>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          Auto-reply to new chats, hand off to teammates after hours, send a follow-up template
          24 hours later. Build one canvas at a time.
        </p>
      </div>
      {canManage && (
        <Button asChild size="sm" variant="outline">
          <Link href="/workflows/new">
            <Plus className="size-4" />
            Create your first workflow
          </Link>
        </Button>
      )}
    </div>
  );
}
