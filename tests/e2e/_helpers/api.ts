import type { APIRequestContext } from "@playwright/test";

/**
 * Thin wrappers around the API surfaces the tests drive. Centralized so
 * each spec stays a sequence of high-level steps; the test reads like
 * "create workflow → publish → trigger → check status."
 *
 * Every helper takes the per-test `request` context that Playwright
 * injects, so authentication (the storageState cookie from auth.setup.ts)
 * rides along automatically.
 */

// ─── Workflows ────────────────────────────────────────────────────────────

export interface CreateWorkflowInput {
  name: string;
  trigger: string;
  triggerConfig?: Record<string, unknown>;
  triggerConditions?: unknown[];
  triggerOncePerContact?: boolean;
  graph: { nodes: unknown[]; edges: unknown[] };
}

export async function createWorkflow(
  request: APIRequestContext,
  input: CreateWorkflowInput,
): Promise<{ id: string; webhookUrl: string | null; webhookSecret: string | null }> {
  const resp = await request.post("/api/workspace/workflows", {
    data: {
      name: input.name,
      trigger: input.trigger,
      triggerConfig: input.triggerConfig ?? {},
      triggerConditions: input.triggerConditions ?? [],
      triggerOncePerContact: input.triggerOncePerContact ?? false,
      graph: input.graph,
    },
  });
  if (!resp.ok()) {
    const body = await resp.text();
    throw new Error(`createWorkflow ${resp.status()}: ${body}`);
  }
  return resp.json();
}

export async function publishWorkflow(
  request: APIRequestContext,
  id: string,
  publish = true,
): Promise<void> {
  const resp = await request.post(`/api/workspace/workflows/${id}/publish`, {
    data: { publish },
  });
  if (!resp.ok()) {
    const body = await resp.text();
    throw new Error(`publishWorkflow ${resp.status()}: ${body}`);
  }
}

// ─── Outbound webhooks ────────────────────────────────────────────────────

export async function createOutboundWebhook(
  request: APIRequestContext,
  input: { name: string; url: string; eventTypes: string[] },
): Promise<{ id: string; secret: string }> {
  const resp = await request.post("/api/workspace/outbound-webhooks", {
    data: input,
  });
  if (!resp.ok()) {
    const body = await resp.text();
    throw new Error(`createOutboundWebhook ${resp.status()}: ${body}`);
  }
  return resp.json();
}

// ─── Conversation mutations ──────────────────────────────────────────────

export async function assignConversation(
  request: APIRequestContext,
  conversationId: string,
  assignedUserId: string | null,
): Promise<void> {
  const resp = await request.post(`/api/conversations/${conversationId}/assign`, {
    data: { assignedUserId },
  });
  if (!resp.ok()) {
    const body = await resp.text();
    throw new Error(`assignConversation ${resp.status()}: ${body}`);
  }
}

export async function setConversationStatus(
  request: APIRequestContext,
  conversationId: string,
  status: "open" | "pending" | "closed",
): Promise<void> {
  const resp = await request.post(`/api/conversations/${conversationId}/status`, {
    data: { status },
  });
  if (!resp.ok()) {
    const body = await resp.text();
    throw new Error(`setConversationStatus ${resp.status()}: ${body}`);
  }
}

export async function addInternalNote(
  request: APIRequestContext,
  conversationId: string,
  body: string,
): Promise<{ id: string }> {
  const resp = await request.post(`/api/notes`, {
    data: { conversationId, body },
  });
  if (!resp.ok()) {
    const text = await resp.text();
    throw new Error(`addInternalNote ${resp.status()}: ${text}`);
  }
  const json = await resp.json();
  return { id: json.noteId };
}
