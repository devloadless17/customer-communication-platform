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

  return <WorkflowBuilder mode="create" catalogs={catalogs} />;
}
