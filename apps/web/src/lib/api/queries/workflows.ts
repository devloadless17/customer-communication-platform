import "server-only";


import type { WorkflowTriggerEvent } from "@prisma/client";

import { api } from "../../api-client";
import { isApiNotFound } from "./helpers";



import { listAssignmentPolicies, listContactFieldDefinitions, listContactStages, listTags } from "./catalogs";
import { listTeamMembers } from "./team";
import { listChannelAccountDirectory, listWhatsappTemplates } from "./whatsapp";


/**
 * Inline DTOs that the API ships but apps/api defines locally in its
 * service files. Kept here (not in @ccp/shared) because the source-of-truth
 * lives next to the controller; this is just the consumer-side mirror so
 * web pages can name the response shape.
 */
// Workflows
// ---------------------------------------------------------------------------

export interface WorkflowListItem {
  id: string;
  name: string;
  published: boolean;
  trigger: string;
  stepCount: number;
  firstStepLabel: string;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function listWorkflows(): Promise<WorkflowListItem[]> {
  const { workflows } = await api<{ workflows: WorkflowListItem[] }>("/api/workspace/workflows");
  return workflows;
}

/**
 * Composite reader used by the workflow builder pages — loads every catalog
 * the canvas needs to render its node palette in one fan-out call. Remaps
 * the wider API shapes down to the minimal `{id, name, …}` shapes the
 * builder consumes so the wire response stays general-purpose.
 */
export async function loadWorkflowCatalogs(): Promise<{
  users: Array<{ id: string; name: string; email: string }>;
  templates: Array<{
    id: string;
    name: string;
    bodyText: string;
    language: string;
    status: string;
  }>;
  tags: Array<{ id: string; name: string; color: string }>;
  stages: Array<{ id: string; name: string; position: number }>;
  fields: Array<{ key: string; label: string }>;
  workflows: Array<{ id: string; name: string; trigger: WorkflowTriggerEvent }>;
  assignmentPolicies: Array<{ id: string; name: string; isDefault: boolean }>;
  channelAccounts: Array<{ id: string; name: string; channel: string }>;
}> {
  const [users, templates, tags, stages, fields, workflows, assignmentPolicies, channelAccounts] =
    await Promise.all([
      listTeamMembers(),
      listWhatsappTemplates(),
      listTags(),
      listContactStages(),
      listContactFieldDefinitions(),
      listWorkflows(),
      listAssignmentPolicies(),
      // `cache()`d and already fetched by the (app) layout, so this is free.
      listChannelAccountDirectory(),
    ]);
  return {
    // Only ACTIVE accounts: a rule keyed to a disconnected number can never
    // fire, so offering it would be a trap.
    channelAccounts: channelAccounts
      .filter((a) => a.isActive)
      .map((a) => ({ id: a.id, name: a.name, channel: a.channel })),
    users: users
      .filter((u) => u.isActive)
      .map((u) => ({ id: u.id, name: u.name, email: u.email })),
    templates: templates.templates.map((t) => ({
      id: t.id,
      name: t.name,
      bodyText: t.bodyText,
      language: t.language,
      status: t.status,
    })),
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
    stages: stages.map((s) => ({ id: s.id, name: s.name, position: s.position })),
    fields: fields.map((f) => ({ key: f.key, label: f.label })),
    workflows: workflows
      .filter((w) => w.trigger === "manual_trigger")
      .map((w) => ({
        id: w.id,
        name: w.name,
        trigger: w.trigger as WorkflowTriggerEvent,
      })),
    assignmentPolicies,
  };
}

export async function getWorkflow(id: string): Promise<Record<string, unknown> | null> {
  try {
    return await api<Record<string, unknown>>(`/api/workspace/workflows/${id}`);
  } catch (err) {
    if (isApiNotFound(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
