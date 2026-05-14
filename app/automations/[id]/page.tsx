import { notFound, redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { db } from "@/lib/db";
import { canManageUsers } from "@/lib/auth/permissions";

import { AutomationForm } from "@/components/automations/automation-form";
import { RunsTable } from "@/components/automations/runs-table";

export const metadata = { title: "Edit automation" };
export const dynamic = "force-dynamic";

export default async function AutomationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, teamId } = await getSession();
  if (!canManageUsers(user.role)) {
    redirect("/automations");
  }
  const { id } = await params;

  const auto = await db.automation.findFirst({
    where: { id, teamId },
  });
  if (!auto) notFound();

  // Hide the actual bearer token in the editor — show a "token set" marker
  // instead so admins know one's stored without it leaking into HTML or
  // network responses. Setting a new value on PATCH overwrites; blank keeps.
  const actionConfig = redactToken(auto.actionConfig);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold">Edit automation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Changes to the webhook URL take effect on the next dispatch — already-
          queued runs use the URL that was current when they were enqueued.
        </p>
      </header>

      <AutomationForm
        mode="edit"
        automation={{
          id: auto.id,
          name: auto.name,
          enabled: auto.enabled,
          trigger: auto.trigger,
          conditions: Array.isArray(auto.conditions) ? auto.conditions : [],
          actionConfig,
        }}
      />

      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium">Recent runs</h2>
          <p className="text-xs text-muted-foreground">
            Last 50 attempts, newest first. Failed runs include the webhook's
            response so you can debug n8n flows in place.
          </p>
        </div>
        <RunsTable automationId={auto.id} />
      </section>
    </div>
  );
}

function redactToken(raw: unknown): { url: string; bearerTokenSet: boolean; customHeaders?: Record<string, string>; timeoutMs?: number } {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw))
    ? (raw as Record<string, unknown>)
    : {};
  return {
    url: typeof r.url === "string" ? r.url : "",
    bearerTokenSet: typeof r.bearerToken === "string" && r.bearerToken.length > 0,
    ...(r.customHeaders && typeof r.customHeaders === "object"
      ? { customHeaders: r.customHeaders as Record<string, string> }
      : {}),
    ...(typeof r.timeoutMs === "number" ? { timeoutMs: r.timeoutMs } : {}),
  };
}
