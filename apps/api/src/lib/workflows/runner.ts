import { Prisma, type WorkflowStepType, type WorkflowTriggerEvent } from "@prisma/client";

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

  // Execute the snapshot pinned at run-creation, NOT the live Workflow.graph —
  // editing a workflow while this run is paused must not change its remaining
  // path. Fall back to the live graph only for pre-migration runs whose
  // graphSnapshot is null; remove the fallback once those have drained.
  const graph = toGraph(run.graphSnapshot ?? wf.graph);
  if (!graph.startNodeId || graph.nodes.length === 0) {
    await markFailed(run.id, "workflow graph is empty");
    return { runId: run.id, status: "failed" };
  }

  await db.workflowRun.update({
    where: { id: run.id },
    data: { status: "running", attempts: input.attempt },
  });

  const envelope = buildEnvelope(wf.teamId, run.trigger, run.eventPayload);
  let currentStepId: string | null = run.currentStepId ?? graph.startNodeId;
  // Tracks the step we advanced FROM to reach the current step. Drives
  // `$var.previousStep.X` token expansion. Carried over resumes via the
  // last terminal stepLog entry's stepId.
  let previousStepId: string | null = null;
  let jumpsUsed = run.jumpsUsed;
  // Read the existing stepLog so we can append (instead of overwriting on retry).
  const stepLog: StepLogEntry[] = Array.isArray(run.stepLog)
    ? (run.stepLog as unknown as StepLogEntry[])
    : [];
  // Per-step structured outputs (`stepId → JSON value`). Persisted to
  // WorkflowRun.stepOutputs after each step so paused runs can resume
  // without losing the prior step's output.
  const stepOutputs: Record<string, unknown> =
    run.stepOutputs && typeof run.stepOutputs === "object" && !Array.isArray(run.stepOutputs)
      ? { ...(run.stepOutputs as Record<string, unknown>) }
      : {};
  // Recover previousStepId on resume by walking the stepLog backwards for
  // the most recent terminal entry of a DIFFERENT step.
  for (let i = stepLog.length - 1; i >= 0; i--) {
    const entry = stepLog[i];
    if (
      entry &&
      entry.stepId !== currentStepId &&
      (entry.status === "success" || entry.status === "waiting")
    ) {
      previousStepId = entry.stepId;
      break;
    }
  }
  // Cap per-step output to ~32KB so a pathological HTTP-request response
  // can't bloat `WorkflowRun.stepOutputs` past a sensible upper bound.
  // The truncation is a marker JSON so consumers can detect it instead of
  // silently seeing a clipped object.
  const STEP_OUTPUT_MAX_BYTES = 32 * 1024;
  function captureStepOutput(stepId: string, body: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = { body };
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(parsed);
    } catch {
      return;
    }
    if (serialized.length > STEP_OUTPUT_MAX_BYTES) {
      stepOutputs[stepId] = {
        __truncated: true,
        size: serialized.length,
        preview: serialized.slice(0, STEP_OUTPUT_MAX_BYTES),
      };
    } else {
      stepOutputs[stepId] = parsed;
    }
  }
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

    // For `ask_question` (and any future await_reply-shaped step), the
    // handler needs to know "is this the first call or a resume?" — first
    // call sends the question, resume picks an outgoing edge. `isResume` is
    // true when ANY prior log entry for this step was status=waiting.
    // `pendingAnswer` is the inbound message the ingest hook dropped onto
    // run.pendingAnswer; null on first call and on the timeout path.
    const isResume = stepLog.some(
      (e) => e.stepId === node.id && e.status === "waiting",
    );
    const pendingAnswer = (run.pendingAnswer ?? null) as
      | {
          body: string;
          messageId: string;
          timestamp: string;
          optionId?: string;
          optionKind?: "button_reply" | "list_reply";
        }
      | null;

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
        pendingAnswer,
        isResume,
        stepOutputs,
        previousStepId,
      });
      // Strip the in-progress sentinel — the success/failed entry below
      // is the canonical record. Leaving the in_progress in place would
      // make the orphan-detect on a LATER step think this one crashed.
      if (inProgressIdx >= 0) stepLog.splice(inProgressIdx, 1);
    } catch (err) {
      // Two flavors of throw:
      //   - UnknownStepTypeError / StepConfigError → permanent (don't retry)
      //   - everything else (network, DB transient) → throw so BullMQ retries
      const isPermanent =
        err instanceof UnknownStepTypeError || err instanceof StepConfigError;

      // For irreversible steps on TRANSIENT throws: preserve the in_progress
      // entry so the next BullMQ attempt's orphan-detect (above) catches it
      // and writes `skipped_after_crash` instead of re-running the side
      // effect. The Meta send may have succeeded between the in_progress
      // write and the throw; double-firing is the bug CLAUDE.md rule #3
      // explicitly exists to prevent. We also skip the per-attempt `failed`
      // breadcrumb in that case — pushing a terminal entry alongside the
      // preserved in_progress would defeat the orphan-detect (which bails
      // when ANY terminal entry exists for the stepId). UI visibility is
      // restored on the retry via the skipped_after_crash entry.
      const preserveInProgressForOrphanDetect =
        !isPermanent && inProgressIdx >= 0 && hasSideEffect(node.type);

      if (!preserveInProgressForOrphanDetect && inProgressIdx >= 0) {
        stepLog.splice(inProgressIdx, 1);
      }

      if (isPermanent) {
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

      if (!preserveInProgressForOrphanDetect) {
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
      }
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
      // waitSeq = current stepLog length (post-push), unique per wait within
      // this run so a workflow with multiple wait steps doesn't collide on
      // the resume jobId. The waiting-sweeper passes the same value when
      // re-enqueueing stranded waits, so its retry stays a no-op while the
      // original delayed job is still alive.
      await enqueueWorkflowResume(run.id, result.delayMs, stepLog.length);
      return { runId: run.id, status: "waiting" };
    }

    if (result.kind === "await_reply") {
      // Like wait, but the step itself is re-executed on resume — so we
      // DON'T advance currentStepId. The handler picks an outgoing edge
      // on the second invocation (`isResume === true`) based on whether
      // pendingAnswer is set by the inbound ingest hook before the
      // resume fires.
      const contactId = run.contactId;
      if (!contactId) {
        // No contact on the run = no way to receive a reply. Skip into
        // the timeout edge on the same step by failing fast; the handler
        // will return branch:timeout the moment we re-execute. But there's
        // no inbound path to trigger that re-execution, so going straight
        // to a permanent failure is the honest outcome.
        stepLog.push({
          stepId: node.id,
          type: node.type,
          status: "failed",
          errorMessage: "ask_question requires a contact-scoped trigger",
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
        });
        await db.workflowRun.update({
          where: { id: run.id },
          data: {
            status: "failed",
            currentStepId: null,
            stepLog: stepLog as unknown as Prisma.InputJsonValue,
            errorMessage: "ask_question requires a contact-scoped trigger",
            finishedAt: new Date(),
          },
        });
        return { runId: run.id, status: "failed" };
      }
      const resumeAt = new Date(Date.now() + result.timeoutMs);
      stepLog.push({
        stepId: node.id,
        type: node.type,
        status: "waiting",
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        responseStatus: result.status,
        responseBody: result.body,
        // No nextStepId — the same step re-runs.
      });
      // Upsert the awaiting row + clear any stale pendingAnswer from a
      // previous ask_question in this run so the next resume only sees a
      // fresh answer from this question.
      await db.$transaction([
        db.workflowAwaitingReply.upsert({
          where: { runId: run.id },
          create: {
            teamId: wf.teamId,
            contactId,
            runId: run.id,
            workflowId: wf.id,
            stepId: node.id,
            expiresAt: resumeAt,
          },
          update: {
            stepId: node.id,
            expiresAt: resumeAt,
          },
        }),
        db.workflowRun.update({
          where: { id: run.id },
          data: {
            status: "waiting",
            // KEEP currentStepId — the same step re-runs on resume.
            waitUntil: resumeAt,
            stepLog: stepLog as unknown as Prisma.InputJsonValue,
            jumpsUsed,
            pendingAnswer: Prisma.DbNull,
          },
        }),
      ]);
      await enqueueWorkflowResume(run.id, result.timeoutMs, stepLog.length);
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

    // Capture the step's output ON success only — a 4xx/5xx response body
    // is often an error object, not a useful upstream value. Successful
    // results feed `$var.previousStep.X` for whatever runs next.
    if (result.status >= 200 && result.status < 400) {
      captureStepOutput(node.id, result.body);
    }

    // Persist BOTH stepLog AND stepOutputs after each step. The previous
    // shape only flushed at run-end / wait — a process death mid-run lost
    // the latest output captures for the next pickup. Cheap update: tiny
    // JSONB writes on the same row. previousStepId follows the same
    // boundary so it's correct even on hot-reload of the runner.
    await db.workflowRun.update({
      where: { id: run.id },
      data: {
        stepLog: stepLog as unknown as Prisma.InputJsonValue,
        stepOutputs: stepOutputs as unknown as Prisma.InputJsonValue,
        jumpsUsed,
      },
    });

    previousStepId = node.id;
    currentStepId = nextId;
  }

  // Loop guard hit — record + fail the run.
  if (progressCount(stepLog) >= MAX_STEPS_PER_RUN) {
    const reason = `step ceiling (${MAX_STEPS_PER_RUN}) exceeded`;
    await db.workflowRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        currentStepId: null,
        stepLog: stepLog as unknown as Prisma.InputJsonValue,
        errorMessage: reason,
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
function hasSideEffect(type: WorkflowStepType): boolean {
  // Drive the answer from the per-handler `sideEffect` declaration so adding
  // a new step type forces the author to opt in/out at the type-system
  // level. The earlier hand-maintained string list silently classified
  // every new step as "pure" — exactly the regression vector CLAUDE.md
  // rule #3 (idempotent Meta sends) exists to prevent.
  const handler = getStepHandler(type);
  return handler.sideEffect === "irreversible";
}

function buildEnvelope(
  teamId: string,
  trigger: WorkflowTriggerEvent,
  payload: unknown,
): WorkflowEventEnvelope {
  const p = payload as {
    conversation?: { id?: string };
    contact?: { id?: string };
    _depth?: unknown;
  };
  const conversationId = p?.conversation?.id ?? "";
  const contactId = p?.contact?.id ?? "";
  // Cross-system chain depth — seeded by the incoming_webhook handler from the
  // inbound X-CCP-Depth header (stored on the run's eventPayload as `_depth`).
  // 0 for every other trigger. The http_request step reads this off the
  // envelope and stamps depth+1 on its outbound call.
  const depth = typeof p?._depth === "number" && Number.isFinite(p._depth) ? p._depth : 0;
  const base = process.env.APP_PUBLIC_URL ?? "http://localhost:3000";
  return {
    version: 1,
    event: trigger,
    teamId,
    occurredAt: new Date().toISOString(),
    data: payload as WorkflowEventEnvelope["data"],
    depth,
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

/**
 * Called by the BullMQ `failed` worker listener after the final retry of a
 * transient-error throw. Without this, a run whose step keeps throwing
 * (network blip, DB transient, etc.) stays in `running` forever — BullMQ
 * gives up but the run row is never moved to a terminal status.
 *
 * Idempotent on two axes:
 *   - Already-terminal runs (`StepConfigError` already wrote `failed`) are
 *     skipped — no double-emit on the bus.
 *   - Missing/deleted runs are silently ignored (a Prisma deletion race).
 *
 * Best-effort: errors here are swallowed because the caller is a BullMQ
 * event listener — throwing would just be logged by BullMQ anyway and
 * there's no useful recovery.
 */
export async function failRunFromRetryExhaustion(
  runId: string,
  reason: string,
): Promise<void> {
  try {
    const run = await db.workflowRun.findUnique({
      where: { id: runId },
      select: { id: true, teamId: true, workflowId: true, status: true },
    });
    if (!run) return;
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "skipped"
    ) {
      return;
    }
    await db.workflowRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        errorMessage: reason,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    console.warn(
      `[workflow-runner] failRunFromRetryExhaustion(${runId}) threw:`,
      err instanceof Error ? err.message : err,
    );
  }
}
