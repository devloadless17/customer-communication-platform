import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { loadWorkflowCatalogs } from "@/lib/api/queries";

import { WorkflowBuilder } from "@/features/workflows/components/builder/workflow-builder";

export const metadata = { title: "New workflow" };
export const dynamic = "force-dynamic";

export default async function NewWorkflowPage() {
  const { user } = await getSession();
  if (!canManageUsers(user.role)) {
    redirect("/workflows");
  }

  const catalogs = await loadWorkflowCatalogs();

  return (
    <>
      {/* The builder canvas has no visible heading on desktop (the mobile
          chrome owns the h1 below `md`), so expose a top-level landmark for
          SR heading nav. Scoped to desktop to avoid a duplicate mobile h1. */}
      <h1 className="sr-only max-md:hidden">New workflow</h1>
      <WorkflowBuilder mode="create" catalogs={catalogs} />
    </>
  );
}
