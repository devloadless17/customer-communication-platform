import type { Prisma, WorkflowTriggerEvent } from "@prisma/client";

import { db } from "@/lib/db";
import { type WorkflowEventEnvelope } from "@/lib/workflows/events";
import { findNextStep, toGraph } from "@/lib/workflows/graph";
import { enqueueWorkflowResume } from "@/lib/workflows/queue";
import {
  UnknownStepTypeError,
  getStepHandler,
} from "@/lib/workflows/steps";
import { StepConfigError, type StepResult } from "@/lib/workflows/steps/types";

/**
 * The DAG runner. Picks up a WorkflowRun by id, walks the graph one step at
 * a time, persists state after each step, and yields back to BullMQ when:
 *
 *   - a `wait` step is reached     → run.status = "waiting", resume job scheduled
 *   - the graph runs out of edges  → run.status = "completed"
 *   - step threw                   → throw → BullMQ retries
 *   - per-run step ceiling hit     → run.status = "failed" (loop guard)
 *
 * Per-run state on WorkflowRun:
 *   - currentStepId — the step that will execute next pickup (or NULL on completed/failed)
 *   - jumpsUsed     — incremented per jump_to_step
 *   - stepLog       — append-only per-step audit; capped at MAX_STEPS_PER_RUN
 */

const MAX_STEPS_PER_RUN = 100;

export interface RunWorkflowInput {
  runId: string;
  attempt: number;
}

export interface RunWorkflowResult {
  runId: string;
  status: "completed" | "failed" | "waiting" | "skipped";
}

export async function runWorkflow(input: RunWorkflowInput): Promise<RunWorkflowResult> {
  const run = await db.workflowRun.findUnique({
    where: { id: input.runId },
    include: {
      workflow: {
        select: {
          id: true,
          teamId: true,
          enabled: true,
          published: true,
          graph: true,
          trigger: true,
        },
      },
    },
  });
  if (!run) {
    // Run deleted between schedule and pickup. Nothing to do.
    return { runId: input.runId, status: "skipped" };
  }
  const wf = run.workflow;
  if (!wf || !wf.enabled || !wf.published) {
    await markSkipped(run.id, "workflow disabled, unpublished, or deleted");
    return { runId: run.id, status: "skipped" };
  }

  const graph = toGraph(wf.graph);
  if (!graph.startNodeId || graph.nodes.length === 0) {
    await markFailed(run.id, "workflow graph is empty");
    return { runId: run.id, status: "failed" };
  }

  // Mark running BEFORE the first step so the UI can show the transition.
  await db.workflowRun.update({
    where: { id: run.id },
    data: { status: "running", attempts: input.attempt },
  });

  const envelope = buildEnvelope(wf.teamId, run.trigger, run.eventPayload);
  let currentStepId: string | null = run.currentStepId ?? graph.startNodeId;
  let jumpsUsed = run.jumpsUsed;
  // Read the existing stepLog so we can append (instead of overwriting on retry).
  const stepLog: StepLogEntry[] = Array.isArray(run.stepLog)
    ? (run.stepLog as unknown as StepLogEntry[])
    : [];
  // Count THIS pickup's executed steps separately from the cumulative one in
  // stepLog. The global ceiling enforces total steps across the run; the
  // pickup-local counter prevents a single resumption from hogging the
  // worker if a stale waiting run woke into a tight loop.
  let executedThisPickup = 0;

  while (currentStepId && stepLog.length < MAX_STEPS_PER_RUN && executedThisPickup < MAX_STEPS_PER_RUN) {
    const node = graph.nodes.find((n) => n.id === currentStepId);
    if (!node) {
      stepLog.push({
        stepId: currentStepId,
        type: "unknown",
        status: "failed",
        errorMessage: `node "${currentStepId}" not found in graph`,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      await db.workflowRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          currentStepId: null,
          stepLog: stepLog as unknown as Prisma.InputJsonValue,
          errorMessage: `step "${currentStepId}" not found in graph`,
          finishedAt: new Date(),
        },
      });
      return { runId: run.id, status: "failed" };
    }

    const startedAt = new Date();
    let result: StepResult;
    try {
      const handler = getStepHandler(node.type);
      const config = handler.parseConfig(node.config);
      result = await handler.run(envelope, config, {
        teamId: wf.teamId,
        workflowId: wf.id,
        runId: run.id,
        trigger: run.trigger,
        attempt: input.attempt,
        stepId: node.id,
        graph,
      });
    } catch (err) {
      // Two flavors of throw:
      //   - UnknownStepTypeError / StepConfigError → permanent (don't retry)
      //   - everything else (network, DB transient) → throw so BullMQ retries
      if (err instanceof UnknownStepTypeError || err instanceof StepConfigError) {
        stepLog.push({
          stepId: node.id,
          type: node.type,
          status: "failed",
          errorMessage: err.message,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
        });
        await db.workflowRun.update({
          where: { id: run.id },
          data: {
            status: "failed",
            currentStepId: null,
            stepLog: stepLog as unknown as Prisma.InputJsonValue,
            errorMessage: err.message,
            finishedAt: new Date(),
          },
        });
        return { runId: run.id, status: "failed" };
      }
      // Persist a failing log entry BEFORE throwing — the next attempt
      // will create a fresh log entry. Without this, transient failures
      // leave no breadcrumb in the UI between retries.
      stepLog.push({
        stepId: node.id,
        type: node.type,
        status: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
      });
      await db.workflowRun.update({
        where: { id: run.id },
        data: {
          currentStepId,
          stepLog: stepLog as unknown as Prisma.InputJsonValue,
          jumpsUsed,
        },
      });
      throw err;
    }

    executedThisPickup += 1;

    if (result.kind === "wait") {
      const resumeAt = new Date(Date.now() + result.delayMs);
      const nextId = findNextStep(graph, node.id);
      stepLog.push({
        stepId: node.id,
        type: node.type,
        status: "waiting",
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        responseStatus: result.status,
        responseBody: result.body,
        nextStepId: nextId,
      });
      await db.workflowRun.update({
        where: { id: run.id },
        data: {
          status: "waiting",
          currentStepId: nextId,
          waitUntil: resumeAt,
          stepLog: stepLog as unknown as Prisma.InputJsonValue,
          jumpsUsed,
        },
      });
      // Schedule the resume. BullMQ delayed jobs survive worker restarts.
      await enqueueWorkflowResume(run.id, result.delayMs);
      return { runId: run.id, status: "waiting" };
    }

    let nextId: string | null;
    if (result.kind === "branch") {
      nextId = findNextStep(graph, node.id, result.selectedLabel);
    } else if (result.kind === "jump") {
      jumpsUsed += 1;
      // Cap jumps per run at the global ceiling minus the step buffer; a
      // workflow that loops forever should fail fast rather than chew the
      // worker. Step config can tighten this further.
      if (jumpsUsed > MAX_STEPS_PER_RUN) {
        nextId = findNextStep(graph, node.id);
      } else {
        nextId = result.targetStepId;
      }
    } else {
      nextId = findNextStep(graph, node.id);
    }

    stepLog.push({
      stepId: node.id,
      type: node.type,
      status: result.status >= 200 && result.status < 400 ? "success" : "failed",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      responseStatus: result.status,
      responseBody: result.body,
      nextStepId: nextId,
    });

    currentStepId = nextId;
  }

  // Loop guard hit — record + fail the run.
  if (stepLog.length >= MAX_STEPS_PER_RUN) {
    await db.workflowRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        currentStepId: null,
        stepLog: stepLog as unknown as Prisma.InputJsonValue,
        errorMessage: `step ceiling (${MAX_STEPS_PER_RUN}) exceeded`,
        finishedAt: new Date(),
      },
    });
    return { runId: run.id, status: "failed" };
  }

  // End-of-graph — completed.
  await db.workflowRun.update({
    where: { id: run.id },
    data: {
      status: "completed",
      currentStepId: null,
      stepLog: stepLog as unknown as Prisma.InputJsonValue,
      jumpsUsed,
      finishedAt: new Date(),
    },
  });
  return { runId: run.id, status: "completed" };
}

interface StepLogEntry {
  stepId: string;
  type: string;
  status: "success" | "failed" | "waiting";
  startedAt: string;
  finishedAt: string;
  responseStatus?: number;
  responseBody?: string;
  errorMessage?: string;
  nextStepId?: string | null;
}

function buildEnvelope(
  teamId: string,
  trigger: WorkflowTriggerEvent,
  payload: unknown,
): WorkflowEventEnvelope {
  const p = payload as { conversation?: { id?: string }; contact?: { id?: string } };
  const conversationId = p?.conversation?.id ?? "";
  const contactId = p?.contact?.id ?? "";
  const base = process.env.APP_PUBLIC_URL ?? "http://localhost:3000";
  return {
    version: 1,
    event: trigger,
    teamId,
    occurredAt: new Date().toISOString(),
    data: payload as WorkflowEventEnvelope["data"],
    _links: {
      conversation: `${base}/api/external/v1/conversations/${conversationId}`,
      messages: `${base}/api/external/v1/conversations/${conversationId}/messages`,
      contact: `${base}/api/external/v1/contacts/${contactId}`,
    },
  };
}

async function markSkipped(runId: string, reason: string): Promise<void> {
  await db.workflowRun.update({
    where: { id: runId },
    data: {
      status: "skipped",
      errorMessage: reason,
      finishedAt: new Date(),
    },
  });
}

async function markFailed(runId: string, reason: string): Promise<void> {
  await db.workflowRun.update({
    where: { id: runId },
    data: {
      status: "failed",
      errorMessage: reason,
      finishedAt: new Date(),
    },
  });
}
