import Link from "next/link";
import { Plus, Webhook, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/current-user";
import { db } from "@/lib/db";
import { canManageUsers } from "@/lib/permissions";
import { formatListTime } from "@/lib/utils";

import { AutomationToggle } from "./automation-toggle";

export const metadata = { title: "Automations" };
export const dynamic = "force-dynamic";

const TRIGGER_LABELS: Record<string, string> = {
  message_received: "Message received",
  conversation_assigned: "Conversation assigned",
  conversation_status_changed: "Status changed",
};

export default async function AutomationsPage() {
  const { user, teamId } = await getSession();
  const canManage = canManageUsers(user.role);

  const rows = await db.automation.findMany({
    where: { teamId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      enabled: true,
      trigger: true,
      actionType: true,
      actionConfig: true,
      createdAt: true,
      _count: { select: { runs: true } },
    },
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Automations</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Trigger an external workflow (n8n, Zapier, your own service) when
            something happens in your inbox. Use the bidirectional API
            (settings → API keys) to call back and act on the conversation.
          </p>
        </div>
        {canManage && (
          <Button asChild>
            <Link href="/automations/new">
              <Plus className="size-4" />
              New automation
            </Link>
          </Button>
        )}
      </header>

      {rows.length === 0 ? (
        <EmptyState canManage={canManage} />
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {rows.map((r) => {
            const url = readWebhookUrl(r.actionConfig);
            return (
              <div
                key={r.id}
                className="flex items-center gap-4 px-4 py-3 hover:bg-accent/30"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Webhook className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/automations/${r.id}`}
                      className="truncate text-sm font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {TRIGGER_LABELS[r.trigger] ?? r.trigger}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                    {url ?? "(no webhook URL)"}
                  </div>
                </div>
                <div className="hidden flex-col items-end gap-0.5 text-right text-[11px] text-muted-foreground sm:flex">
                  <div>{r._count.runs} run{r._count.runs === 1 ? "" : "s"}</div>
                  <div>{formatListTime(r.createdAt.toISOString())}</div>
                </div>
                {canManage && (
                  <AutomationToggle id={r.id} enabled={r.enabled} />
                )}
              </div>
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
        <Zap className="size-5" />
      </div>
      <div>
        <div className="text-sm font-medium">No automations yet</div>
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          Wire an inbound message, an assignment, or a status change to your own
          workflow. Pair with the external API to let your workflow send replies
          back into the inbox.
        </p>
      </div>
      {canManage && (
        <Button asChild size="sm" variant="outline">
          <Link href="/automations/new">
            <Plus className="size-4" />
            Create your first automation
          </Link>
        </Button>
      )}
    </div>
  );
}

function readWebhookUrl(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const url = (raw as Record<string, unknown>).url;
  return typeof url === "string" ? url : null;
}
