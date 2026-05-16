import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { canManageUsers } from "@/lib/auth/permissions";
import { db } from "@/lib/db";

import { WorkflowBuilder } from "@/components/workflows/builder/workflow-builder";

export const metadata = { title: "New workflow" };
export const dynamic = "force-dynamic";

export default async function NewWorkflowPage() {
  const { user, teamId } = await getSession();
  if (!canManageUsers(user.role)) {
    redirect("/workflows");
  }

  const catalogs = await loadCatalogs(teamId);

  return <WorkflowBuilder mode="create" catalogs={catalogs} />;
}

async function loadCatalogs(teamId: string) {
  const [users, templates, tags, stages, fields, workflows] = await Promise.all([
    db.user.findMany({
      where: { teamId, deactivatedAt: null },
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, email: true },
    }),
    db.messageTemplate.findMany({
      where: { teamId },
      orderBy: [{ name: "asc" }, { language: "asc" }],
      select: { id: true, name: true, bodyText: true, language: true, status: true },
    }),
    db.tag.findMany({
      where: { teamId },
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, color: true },
    }),
    db.contactStage.findMany({
      where: { teamId },
      orderBy: [{ position: "asc" }],
      select: { id: true, name: true, position: true },
    }),
    db.contactFieldDefinition.findMany({
      where: { teamId },
      orderBy: [{ order: "asc" }],
      select: { key: true, label: true },
    }),
    db.workflow.findMany({
      where: { teamId, trigger: "manual_trigger" },
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, trigger: true },
    }),
  ]);
  return { users, templates, tags, stages, fields, workflows };
}
