import type { WorkflowTriggerEvent } from "@prisma/client";
import { notFound, redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { canManageUsers } from "@/lib/auth/permissions";
import { db } from "@/lib/db";

import { WorkflowBuilder } from "@/components/workflows/builder/workflow-builder";

export const metadata = { title: "Edit workflow" };
export const dynamic = "force-dynamic";

export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { user, teamId } = await getSession();
  if (!canManageUsers(user.role)) {
    redirect("/workflows");
  }
  const { id } = await params;

  const wf = await db.workflow.findFirst({ where: { id, teamId } });
  if (!wf) notFound();

  const catalogs = await loadCatalogs(teamId);

  const graph =
    wf.graph && typeof wf.graph === "object" && !Array.isArray(wf.graph)
      ? (wf.graph as unknown as { startNodeId: string; nodes: unknown[]; edges: unknown[] })
      : { startNodeId: "", nodes: [], edges: [] };

  // Redact http_request bearer tokens in the graph before passing to the
  // client. The full redactor lives server-side; we just flip the
  // `bearerTokenSet` marker here to keep the page server-only-friendly.
  const redactedGraph = redactGraphForClient(graph);

  return (
    <WorkflowBuilder
      mode="edit"
      catalogs={catalogs}
      workflow={{
        id: wf.id,
        name: wf.name,
        enabled: wf.enabled,
        published: wf.published,
        trigger: wf.trigger as WorkflowTriggerEvent,
        triggerConfig:
          wf.triggerConfig && typeof wf.triggerConfig === "object" && !Array.isArray(wf.triggerConfig)
            ? (wf.triggerConfig as Record<string, unknown>)
            : {},
        triggerConditions: wf.triggerConditions,
        triggerOncePerContact: wf.triggerOncePerContact,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        graph: redactedGraph as any,
      }}
    />
  );
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

function redactGraphForClient(graph: {
  startNodeId: string;
  nodes: unknown[];
  edges: unknown[];
}) {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const node = n as { id: string; type: string; config: Record<string, unknown>; position?: unknown };
      if (node.type === "http_request") {
        const cfg = { ...node.config };
        if (typeof cfg.bearerToken === "string" && cfg.bearerToken.length > 0) {
          cfg.bearerTokenSet = true;
          delete cfg.bearerToken;
        }
        return { ...node, config: cfg };
      }
      return node;
    }),
  };
}
