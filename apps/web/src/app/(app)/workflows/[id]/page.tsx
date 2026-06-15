import type { WorkflowTriggerEvent } from "@prisma/client";
import { notFound, redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { getWorkflow, loadWorkflowCatalogs } from "@/lib/api/queries";

import { WorkflowBuilder } from "@/features/workflows/components/builder/workflow-builder";

export const metadata = { title: "Edit workflow" };
export const dynamic = "force-dynamic";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user } = await getSession();
  if (!canManageUsers(user.role)) {
    redirect("/workflows");
  }
  const { id } = await params;

  const [wf, catalogs] = await Promise.all([getWorkflow(id), loadWorkflowCatalogs()]);
  if (!wf) notFound();

  // The detail endpoint already runs `redactGraphForClient` server-side
  // (bearer tokens swapped for `bearerTokenSet: true`) so the page can pass
  // the graph through unchanged.
  return (
    <>
      {/* The builder canvas has no visible heading on desktop (the mobile
          chrome owns the h1 below `md`), so expose a top-level landmark for
          SR heading nav. Scoped to desktop to avoid a duplicate mobile h1. */}
      <h1 className="sr-only max-md:hidden">{wf.name as string}</h1>
      <WorkflowBuilder
        mode="edit"
        catalogs={catalogs}
        workflow={{
          id: wf.id as string,
          name: wf.name as string,
          published: wf.published as boolean,
          trigger: wf.trigger as WorkflowTriggerEvent,
          triggerConfig:
            wf.triggerConfig && typeof wf.triggerConfig === "object" && !Array.isArray(wf.triggerConfig)
              ? (wf.triggerConfig as Record<string, unknown>)
              : {},
          triggerConditions: (wf.triggerConditions ?? null) as never,
          triggerOncePerContact: (wf.triggerOncePerContact ?? false) as boolean,

          graph: wf.graph as any,
        }}
      />
    </>
  );
}
