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

  // For the global ceiling we count DISTINCT steps that reached a terminal
  // outcome (success / waiting / permanently failed), not raw log length.
  // Transient failures (BullMQ retry path) append a `failed` entry per
  // attempt — without this filter, three retries of a single flapping
  // step burn three slots against the 100-step cap and a long workflow
  // hits the ceiling prematurely.
  function progressCount(log: StepLogEntry[]): number {
    return new Set(log.map((e) => e.stepId)).size;
  }

  while (currentStepId && progressCount(stepLog) < MAX_STEPS_PER_RUN && executedThisPickup < MAX_STEPS_PER_RUN) {
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

    // Orphan-detect: if a PRIOR attempt left an `in_progress` entry for
    // this exact step without a matching terminal entry, the previous
    // worker died mid-side-effect. We CAN'T know whether the side effect
    // (sendText / template / assign / tag / update_field) actually fired,
    // so we presume YES and advance without re-running. Better one missed
    // workflow than a double-charged WhatsApp send. The
    // `skipped_after_crash` entry is what an admin checks to reconcile.
    const orphanInProgress = stepLog.find(
      (e) =>
        e.stepId === node.id &&
        e.status === "in_progress" &&
        !stepLog.some(
          (later) =>
            later.stepId === node.id &&
            later !== e &&
            (later.status === "success" ||
              later.status === "failed" ||
              later.status === "skipped_after_crash"),
        ),
    );
    if (orphanInProgress && hasSideEffect(node.type)) {
      stepLog.push({
        stepId: node.id,
        type: node.type,
        status: "skipped_after_crash",
        attempt: input.attempt,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        errorMessage:
          "Previous attempt died mid-step. Side effect (e.g. Meta send) " +
          "may have completed. Advancing without re-running to avoid duplicates.",
      });
      const nextStepId = findNextStep(graph, node.id);
      currentStepId = nextStepId;
      executedThisPickup += 1;
      await db.workflowRun.update({
        where: { id: run.id },
        data: {
          currentStepId,
          stepLog: stepLog as unknown as Prisma.InputJsonValue,
          jumpsUsed,
        },
      });
      continue;
    }

    // For side-effect steps, journal an `in_progress` entry BEFORE the
    // call. If the worker crashes between this write and the side-effect
    // returning, the orphan-detect above will catch it on retry. For
    // pure-compute steps (branch / wait config / jump_to) we skip the
    // pre-write since there's no irreversible side effect to lose.
    let inProgressIdx = -1;
    if (hasSideEffect(node.type)) {
      stepLog.push({
        stepId: node.id,
        type: node.type,
        status: "in_progress",
        attempt: input.attempt,
        startedAt: startedAt.toISOString(),
      });
      inProgressIdx = stepLog.length - 1;
      await db.workflowRun.update({
        where: { id: run.id },
        data: {
          stepLog: stepLog as unknown as Prisma.InputJsonValue,
        },
      });
    }

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
      // Strip the in-progress sentinel — the success/failed entry below
      // is the canonical record. Leaving the in_progress in place would
      // make the orphan-detect on a LATER step think this one crashed.
      if (inProgressIdx >= 0) stepLog.splice(inProgressIdx, 1);
    } catch (err) {
      if (inProgressIdx >= 0) stepLog.splice(inProgressIdx, 1);
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
  if (progressCount(stepLog) >= MAX_STEPS_PER_RUN) {
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
  /**
   * `in_progress` is written BEFORE the side effect runs (sendText / template /
   * assign / tag / update_field) and replaced with `success` / `failed` after.
   * If the worker process dies mid-step, the next retry sees the orphaned
   * `in_progress` entry and ADVANCES the step without re-running — accepts
   * "presumed sent, manual reconcile if needed" over "double-sent to Meta".
   *
   * `skipped_after_crash` is the terminal status the retry writes when it
   * encounters such an orphan; surfaces in the runs UI so an admin can
   * verify whether the side effect actually happened.
   */
  status: "in_progress" | "success" | "failed" | "waiting" | "skipped_after_crash";
  /** Attempt counter (1-based) of the run pickup that wrote this entry. */
  attempt?: number;
  startedAt: string;
  finishedAt?: string;
  responseStatus?: number;
  responseBody?: string;
  errorMessage?: string;
  nextStepId?: string | null;
}

/**
 * Step types whose execution has an irreversible side effect (Meta send,
 * DB mutation visible to other observers). For these the runner journals
 * an `in_progress` entry BEFORE invoking the handler so a crashed retry
 * can detect the orphan and SKIP without re-running.
 *
 * Pure-compute / control-flow steps (branch / wait / jump / http_request —
 * the latter is at-least-once by HTTP semantics anyway and its callee is
 * expected to dedupe) are excluded so the stepLog stays focused.
 */
function hasSideEffect(type: string): boolean {
  return (
    type === "send_message" ||
    type === "send_template" ||
    type === "assign_to" ||
    type === "set_status" ||
    type === "open_conversation" ||
    type === "close_conversation" ||
    type === "add_tag" ||
    type === "remove_tag" ||
    type === "update_field" ||
    type === "update_lifecycle" ||
    type === "add_comment" ||
    type === "trigger_workflow"
  );
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
