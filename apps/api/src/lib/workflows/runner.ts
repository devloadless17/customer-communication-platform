import { Prisma, type WorkflowStepType, type WorkflowTriggerEvent } from "@prisma/client";

import { db } from "@/lib/db";
import { type WorkflowEventEnvelope } from "@/lib/workflows/events";
import {
  findNextStep,
  MAX_WORKFLOW_NODES,
  toGraph,
  type WorkflowGraph,
} from "@/lib/workflows/graph";
import {
  acquireWorkflowRunLock,
  enqueueWorkflowResume,
  releaseWorkflowRunLock,
  renewWorkflowRunLock,
} from "@/lib/workflows/queue";
import {
  UnknownStepTypeError,
  getStepHandler,
} from "@/lib/workflows/steps";
import { StepConfigError, type StepHandler, type StepResult } from "@/lib/workflows/steps/types";

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
 *   - stepLog       — append-only per-step audit. NOT capped — see the read
 *                     site below for why truncating it would break the
 *                     MAX_STEPS_PER_RUN ceiling (which counts DISTINCT
 *                     stepIds from this array).
 */

// Aligned with the publish-time node cap (graph.ts MAX_WORKFLOW_NODES): a valid
// acyclic workflow can traverse at most one distinct step per node, so the
// runtime ceiling MUST cover the largest publishable graph or a legitimate
// 101–200-node workflow would run halfway and then FAIL as if it were a loop.
// Loops remain bounded: jump_to_step increments `jumpsUsed` (capped at this
// value) and re-runs spike `executedThisPickup` (also capped here), while the
// per-step send budget caps externally-visible side effects independently.
const MAX_STEPS_PER_RUN = MAX_WORKFLOW_NODES;

// Tolerance for the "resume isn't due yet" guard below — absorbs BullMQ
// delayed-job jitter and small clock skew so an on-time resume is never
// mistaken for a stale early fire.
const RESUME_NOT_DUE_TOLERANCE_MS = 2_000;

export interface RunWorkflowInput {
  runId: string;
  attempt: number;
  /**
   * True when this pickup came from an `inbound-${runId}-${tag}` resume job —
   * i.e. the contact replied to an `ask_question`. Such resumes are ALWAYS due
   * (the reply just landed) even when `waitUntil` is hours away, so the
   * stale-resume guard must let them through. Defaults to false for the
   * initial run, scheduled `resume-` jobs, and BullMQ retries.
   */
  isInboundResume?: boolean;
}

export interface RunWorkflowResult {
  runId: string;
  status: "completed" | "failed" | "waiting" | "skipped";
  /**
   * Set on a `skipped` result when the run was abandoned because the workflow
   * was UNPUBLISHED or DELETED between dispatch and pickup — i.e. it never
   * executed for this contact. The worker must roll back the once-per-contact
   * ledger in that case, else a `triggerOncePerContact` workflow that was
   * briefly unpublished locks the contact out forever (re-publishing never
   * re-fires for them). NOT set on the terminal/stale-resume/lost-lock skips,
   * which are genuine no-ops on an already-claimed run and must keep the ledger.
   */
  releaseLedger?: boolean;
}

// Per-run lock TTL. A single pickup has NO reliable wall-clock bound (it runs
// steps until a wait/terminal, and one http_request step alone can take up to
// 60s), so this is NOT a "max pickup" — it's the lapse window if the process
// DIES. While the pickup is alive a heartbeat renews the lock at TTL/3, so it
// never lapses mid-flight; on a dead lane the heartbeat stops and the lock
// expires after one TTL so the BullMQ stalled-redelivery recovers.
//
// It MUST be strictly less than the BullMQ job lockDuration (WORKFLOW_LOCK_
// DURATION_MS, 90s) — worker.ts boot-asserts this. Why: when a lane crashes
// mid-step the redelivered job must be able to ACQUIRE this run-lock, else
// runWorkflow returns "skipped", BullMQ marks the redelivery COMPLETED (a
// resolved processor ends the job with no further retry), and the run strands
// in "running" forever with no sweeper to recover it. BullMQ can't redeliver
// until the 90s job-lock lapses, so a TTL below 90s guarantees this run-lock
// has already expired by the time the redelivery lands — the retry resumes the
// run instead of no-op-skipping it. The heartbeat (renew at TTL/3) keeps a LIVE
// long pickup's lock alive regardless of the TTL, so shrinking it doesn't
// weaken the concurrent-lane double-fire guard this lock exists for.
export const RUN_LOCK_TTL_MS = 60_000;

/**
 * Per-run mutual-exclusion wrapper around the real runner. BullMQ's per-JOB
 * lock does NOT prevent two jobs for the SAME run executing concurrently (the
 * inbound `ask_question` reply ≈ dangling timeout-job race), so without this a
 * resume branch could double-fire non-idempotent side effects. See
 * acquireWorkflowRunLock for the full rationale.
 */
export async function runWorkflow(input: RunWorkflowInput): Promise<RunWorkflowResult> {
  const lockToken = await acquireWorkflowRunLock(input.runId, RUN_LOCK_TTL_MS);
  if (!lockToken) {
    // Another lane already holds this run — yield. The holder advances the run
    // exactly once. "skipped" tells BullMQ this job is done (no retry needed);
    // it does NOT touch run state, so the winning lane's outcome stands.
    return { runId: input.runId, status: "skipped" };
  }
  // Heartbeat: keep the lock alive for the WHOLE pickup, however long. Without
  // this a long pickup (several maxed http_request steps) could outlive the
  // static TTL, freeing the lock for a second lane (a due ask_question timeout
  // job) to acquire and double-execute. Renew at TTL/3; `unref` so it never
  // keeps the process alive past shutdown.
  const heartbeat = setInterval(() => {
    void renewWorkflowRunLock(input.runId, lockToken, RUN_LOCK_TTL_MS);
  }, Math.floor(RUN_LOCK_TTL_MS / 3));
  heartbeat.unref?.();
  try {
    return await runWorkflowLocked(input);
  } finally {
    clearInterval(heartbeat);
    await releaseWorkflowRunLock(input.runId, lockToken);
  }
}

async function runWorkflowLocked(input: RunWorkflowInput): Promise<RunWorkflowResult> {
  const run = await db.workflowRun.findUnique({
    where: { id: input.runId },
    include: {
      workflow: {
        select: {
          id: true,
          workspaceId: true,
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
  // A TEST run (created by WorkflowsService.test, tagged with the `__test`
  // sentinel on its eventPayload) is allowed to execute a DRAFT workflow —
  // that is the entire point of "test this draft from the canvas", which was
  // previously a silent no-op because the published gate below short-circuited
  // every draft run. The gate is still read LIVE for every NON-test run
  // (dispatch / manual / webhook), so only an explicit test bypasses it; a
  // deleted workflow is always skipped.
  const isTestRun =
    !!run.eventPayload &&
    typeof run.eventPayload === "object" &&
    !Array.isArray(run.eventPayload) &&
    (run.eventPayload as { __test?: unknown }).__test === true;
  if (!wf) {
    await markSkipped(run.id, "workflow deleted");
    // Workflow gone → release the ledger (the row is likely cascade-gone too,
    // making this a harmless no-op, but it keeps the contract symmetric).
    return { runId: run.id, status: "skipped", releaseLedger: true };
  }
  if (!wf.published && !isTestRun) {
    await markSkipped(run.id, "workflow unpublished");
    // Unpublished mid-flight → the run never executed for this contact; release
    // the once-per-contact ledger so re-publishing re-fires for them.
    return { runId: run.id, status: "skipped", releaseLedger: true };
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

  // Terminal-status guard. A run that already reached a terminal state
  // (completed / failed / skipped) must NEVER re-execute. The canonical
  // trigger is the dangling `ask_question` TIMEOUT job: when a contact replies
  // early, the inbound resume advances the run to completion, but NOTHING
  // cancels the timeout job (`resume-${runId}-${waitSeq}`), so it fires hours
  // later (default 24h). On a terminal run `currentStepId` is NULL, so without
  // this guard the `?? graph.startNodeId` fallback below would silently restart
  // the ENTIRE workflow from the start node — re-sending WhatsApp messages,
  // re-applying tags/fields, re-dispatching child workflows. The per-step
  // orphan-journaling can't catch it (a from-start re-run has empty per-step
  // history), so the only safe answer is to refuse the pickup outright. The
  // `waiting`-only guard below does NOT cover this case (a completed run is not
  // `waiting`). Cheap: a stale resume on a finished run becomes a no-op.
  if (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "skipped"
  ) {
    return { runId: run.id, status: run.status };
  }

  // Stale / not-yet-due resume guard.
  //
  // A BullMQ resume job can fire for a wait the run already advanced past —
  // the canonical case is the `ask_question` TIMEOUT job. When a contact
  // replies early, the inbound resume advances the run, but NOTHING cancels
  // the dangling timeout job (`resume-${runId}-${waitSeq}`). If that job later
  // fires while the run is parked at a LATER wait, naively executing
  // `currentStepId` would wake the run prematurely (running downstream steps
  // ahead of their wait), and in the knife-edge reply≈timeout case it would
  // run CONCURRENTLY with the inbound resume (BullMQ locks per-job, not
  // per-run) — double side-effects.
  //
  // Guard: when the run is still `waiting`, its `waitUntil` hasn't arrived,
  // and this isn't an early INBOUND reply, this pickup is a stale/early resume
  // — leave the run parked and let the resume job for the CURRENT wait fire on
  // time (the waiting-runs sweeper is the backstop for a genuinely early fire).
  // Never blocks legitimate work: a fresh run (status≠"waiting"), a due resume
  // (now≥waitUntil), an early inbound reply (`isInboundResume`), or a BullMQ
  // retry of a thrown step (status left "running").
  //
  // Discriminate on the job KIND, not `pendingAnswer`: after an *answered*
  // ask_question, `pendingAnswer` lingers on the run (nothing clears it until
  // the next ask_question), so it can't distinguish a fresh inbound reply from
  // a stale timeout job that fires while the run is parked at a later wait.
  //
  // BUT job-kind alone is too coarse for the INBOUND path. The
  // `inbound-${runId}-${tag}` job's `isInboundResume=true` bypasses the
  // not-due guard so an early reply can wake an ask_question before its
  // timeout. The hazard: nothing cancels the dangling ask_question TIMEOUT
  // job (`resume-${runId}-${waitSeq}`). In the knife-edge reply≈timeout race
  // both fire; if the timeout job's enqueue happens to carry the inbound flag
  // (it can't today — only `inbound-` jobs set it — but a future enqueue path
  // could), OR the run has since advanced to a LATER wait step, an
  // unconditional inbound bypass would run downstream steps prematurely +
  // concurrently with the legitimate resume (double side-effects). So gate the
  // bypass on the run ACTUALLY being parked on an ask_question awaiting a
  // reply: `currentStepId` resolves to an ask_question node whose newest
  // stepLog entry is `waiting`. (We can't require a live WorkflowAwaitingReply
  // row — the inbound ingest hook deletes it BEFORE enqueueing this resume.)
  // If the run isn't parked there, this inbound pickup is stale → no-op like
  // any other stale resume.
  if (run.status === "waiting" && run.waitUntil) {
    const notYetDue =
      Date.now() < run.waitUntil.getTime() - RESUME_NOT_DUE_TOLERANCE_MS;
    if (input.isInboundResume) {
      if (notYetDue && !isParkedOnAskQuestionAwaitingReply(graph, run.currentStepId, run.stepLog)) {
        // Inbound resume for a run that is NOT parked on an ask_question (it
        // advanced to a later wait, or never reached one) AND whose current
        // wait isn't due — a stale/dangling job. Leave it parked.
        return { runId: run.id, status: "waiting" };
      }
    } else if (notYetDue) {
      return { runId: run.id, status: "waiting" };
    }
  }

  await db.workflowRun.update({
    where: { id: run.id },
    data: {
      status: "running",
      attempts: input.attempt,
      // Pin the entry step for a genuinely-fresh run (currentStepId still null
      // from createAndEnqueue). Without this, a crash while executing the FIRST
      // step (a common shape: "message received → send greeting") reloads with
      // currentStepId=null AND a non-empty stepLog, so the corruption guard
      // below misfires and marks the run failed — defeating the orphan
      // skip-after-crash / ask_question re-arm recovery for first-step nodes.
      // A resumed run already has a non-null currentStepId, so this is a no-op
      // rewrite of the same value for it.
      currentStepId: run.currentStepId ?? graph.startNodeId,
    },
  });

  const envelope = buildEnvelope(wf.workspaceId, run.trigger, run.eventPayload);
  // VIII — media_url rehydrate. The trigger-time message snapshot pinned on
  // eventPayload predates the async media download (inbound media is fetched
  // out-of-band; see CLAUDE.md "Inbound media downloads ASYNC"), so its
  // `mediaUrl` is usually null at dispatch even when the binary later lands.
  // Re-read the message row by id once here, BEFORE token resolution /
  // envelope serialization, and overlay the fresh CDN links onto
  // `envelope.data.message` so `$var.message.media_url` is populated. Mirrors
  // the outbound-webhooks subscriber's enrichMessages media re-read. Best-
  // effort: a missing/uncompleted row leaves the existing nulls in place.
  await rehydrateMessageMedia(envelope);
  // Resolve the entry step. A NULL `currentStepId` only means "start from the
  // beginning" for a genuinely-fresh run (the initial `queued` pickup with no
  // stepLog). The terminal-status guard above already rejects completed/failed/
  // skipped runs, so a NULL here on a run that has ALREADY made progress
  // (non-empty stepLog, status running/waiting) is a corruption signal, not a
  // restart instruction — defend against it rather than silently re-running
  // the graph from the start node (defense-in-depth behind the terminal guard).
  const hasPriorProgress = Array.isArray(run.stepLog) && run.stepLog.length > 0;
  if (run.currentStepId == null && hasPriorProgress) {
    // Distinguish "crash lost only the completion write" from real corruption.
    // Once currentStepId advances per step (see the success-advance write), the
    // ONLY way a running/waiting run reaches null currentStepId is the terminal
    // step's success write (nextId=null); if the worker then dies before the
    // completion write, redelivery lands here. The signature is unambiguous: the
    // newest stepLog entry is a terminal SUCCESS with no onward step. Converge it
    // to completed (idempotent — every side effect already committed) instead of
    // false-failing an already-done run. Anything else is genuine corruption.
    const prior = run.stepLog as unknown as StepLogEntry[];
    const last = prior[prior.length - 1];
    const naturallyCompleted =
      !!last && last.status === "success" && last.nextStepId == null;
    if (naturallyCompleted) {
      await db.workflowRun.update({
        where: { id: run.id },
        data: {
          status: "completed",
          currentStepId: null,
          stepLog: prior as unknown as Prisma.InputJsonValue,
          finishedAt: new Date(),
        },
      });
      return { runId: run.id, status: "completed" };
    }
    await markFailed(
      run.id,
      "resume with null currentStepId on an in-progress run (corrupt state; refusing to restart from start node)",
    );
    return { runId: run.id, status: "failed" };
  }
  let currentStepId: string | null = run.currentStepId ?? graph.startNodeId;
  // Tracks the step we advanced FROM to reach the current step. Drives
  // `$var.previousStep.X` token expansion. Carried over resumes via the
  // last terminal stepLog entry's stepId.
  let previousStepId: string | null = null;
  let jumpsUsed = run.jumpsUsed;
  // Read the existing stepLog so we can append (instead of overwriting on retry).
  //
  // GROWTH, known and deliberately NOT truncated (2026-07-18). This array gets
  // one entry per EXECUTION, not per distinct step, and the whole JSONB is
  // rewritten after every step. A jump loop running to its 200-jump ceiling
  // with 3 nodes per iteration reaches ~600 entries (~1.3MB) and costs a few
  // hundred MB of row writes plus WAL/TOAST churn for a single run, while
  // holding a worker slot.
  //
  // The obvious fix — keep only the newest N — is WRONG here, and quietly so:
  // `progressCount` below derives the MAX_STEPS_PER_RUN loop ceiling from the
  // DISTINCT stepIds in this very array. Truncating it lowers that count and
  // hands a runaway workflow a fresh budget, converting a bounded run into an
  // unbounded one. Trading a write-amplification problem for a loop-safety
  // hole is a bad trade.
  //
  // Doing it properly means persisting the distinct-step count as its own
  // column so the ceiling survives truncation — the pattern `jumpsUsed`
  // already uses. That is a schema + migration change, not a local tweak.
  // TRIGGER: a tenant whose workflow queue backs up behind long jump loops, or
  // WorkflowRun table bloat showing up in disk usage.
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
  // Set when a jump ceiling trips, so the terminal write below reports the
  // real reason instead of a silent `completed`.
  let jumpCeilingHit: string | null = null;

  // For the global ceiling we count DISTINCT steps that reached a terminal
  // outcome (success / waiting / permanently failed), not raw log length.
  // Transient failures (BullMQ retry path) append a `failed` entry per
  // attempt — without this filter, three retries of a single flapping
  // step burn three slots against the MAX_STEPS_PER_RUN cap and a long workflow
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

    // Resolve the handler ONCE up front, inside a try so an UNKNOWN step type
    // (a draft saved with a bogus node type + run via POST /:id/test, which
    // bypasses the publish gate) fails PERMANENTLY here — the same clean
    // per-step failure the catch below produces — instead of throwing UNCAUGHT
    // out of the loop from a downstream `hasSideEffect()` / `getStepHandler()`
    // call. That uncaught throw burned the full BullMQ retry budget and marked
    // the run failed with a generic "retry exhausted" message. Once this
    // passes, every later `hasSideEffect(node.type)` / handler lookup for this
    // node is guaranteed not to throw.
    let handler: StepHandler<unknown>;
    try {
      handler = getStepHandler(node.type);
    } catch (err) {
      if (err instanceof UnknownStepTypeError) {
        stepLog.push({
          stepId: node.id,
          type: node.type,
          status: "failed",
          errorMessage: err.message,
          startedAt: new Date().toISOString(),
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
      throw err;
    }

    const startedAt = new Date();

    // Orphan-detect: if a PRIOR attempt left an `in_progress` entry for
    // this exact step without a matching terminal entry, the previous
    // worker died mid-side-effect. We CAN'T know whether the side effect
    // (sendText / template / assign / tag / update_field) actually fired,
    // so we presume YES and advance without re-running. Better one missed
    // workflow than a double-charged WhatsApp send. The
    // `skipped_after_crash` entry is what an admin checks to reconcile.
    // POSITION MATTERS. This used to scan the WHOLE log for a terminal entry
    // with the same stepId, which silently defeated the guarantee two lines
    // above on any workflow that RE-ENTERS a step — i.e. exactly the
    // `jump_to_step` clarifier loop this runner documents as supported
    // ("ask → timeout edge → send clarifier → jump back to ask").
    //
    // Iteration 1 leaves `success` for node X. Iteration 2 journals
    // `in_progress` for X and the worker then dies mid-send. BullMQ redelivers
    // legitimately, the scan finds iteration 1's `success`, concludes "not an
    // orphan", and RE-RUNS the handler — a second billed WhatsApp template to
    // the same customer. (A prior crash's `skipped_after_crash` masks the next
    // orphan the same way.) Nothing else covers this: the run lock, the BullMQ
    // lock and the stalled-count guards all consider that redelivery valid;
    // this check is the only thing standing between it and the re-send.
    //
    // So: take the NEWEST `in_progress` (same newest-entry convention as
    // `isResume` and the ask_question park check below) and only let entries
    // AFTER it count as resolving it. Also drops the old nested scan from
    // O(n²) to O(n) per step.
    let orphanInProgress: (typeof stepLog)[number] | undefined;
    for (let i = stepLog.length - 1; i >= 0; i--) {
      const e = stepLog[i];
      if (!e || e.stepId !== node.id || e.status !== "in_progress") continue;
      const resolvedAfter = stepLog
        .slice(i + 1)
        .some(
          (later) =>
            later.stepId === node.id &&
            (later.status === "success" ||
              later.status === "failed" ||
              later.status === "skipped_after_crash"),
        );
      if (!resolvedAfter) orphanInProgress = e;
      break;
    }
    if (orphanInProgress && hasSideEffect(node.type)) {
      // WF-2 (I-5): an await_reply-producing step (ask_question) whose side
      // effect — the question SEND — fired, but whose await state wasn't
      // persisted before the crash, must NOT advance down an arbitrary edge.
      // That strands the contact (they reply, but the run already moved on).
      // Instead RE-ARM the await so the reply (or the timeout) drives the
      // resume. The send already happened, so we do NOT re-run the handler
      // (no resend). Falls through to the advance path below only when we
      // can't re-arm (no contact, unparseable config, or — see below — this is a
      // RESUME-phase orphan).
      //
      // resumeOrphan: a prior `waiting` entry for this step means the await was
      // ALREADY armed once and the contact's answer may have already been
      // consumed (run.pendingAnswer set + the awaiting row deleted). Re-arming
      // would null that pendingAnswer and re-wait, silently DISCARDING the
      // answer. So only re-arm a FIRST-send orphan; let a resume-phase crash fall
      // through to the advance path (its prior, non-answer-destroying behavior).
      const resumeOrphan = stepLog.some(
        (e) => e.stepId === node.id && e.status === "waiting",
      );
      if (producesAwaitReply(node.type) && run.contactId && !resumeOrphan) {
        let timeoutMs: number | null = null;
        try {
          const cfg = getStepHandler(node.type).parseConfig(node.config) as {
            timeoutHours?: number;
          };
          if (typeof cfg.timeoutHours === "number" && Number.isFinite(cfg.timeoutHours)) {
            timeoutMs = cfg.timeoutHours * 60 * 60 * 1000;
          }
        } catch {
          // Unparseable config on a running step shouldn't happen — fall
          // through to the advance path below as the safe default.
        }
        if (timeoutMs !== null) {
          const resumeAt = new Date(Date.now() + timeoutMs);
          // Reconciliation breadcrumb (matches the advance path's marker).
          stepLog.push({
            stepId: node.id,
            type: node.type,
            status: "skipped_after_crash",
            attempt: input.attempt,
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            errorMessage:
              "Previous attempt died after the await-reply send but before the " +
              "await was persisted. Re-arming the await instead of advancing " +
              "(question already sent; NOT re-sending).",
          });
          // `waiting` entry so the next pickup sees isResume=true (mirrors the
          // normal await_reply path) and the handler picks an outgoing edge.
          stepLog.push({
            stepId: node.id,
            type: node.type,
            status: "waiting",
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
          });
          // Same upsert + run-update + resume enqueue as the normal await_reply
          // result handler — pin currentStepId at this ask node so the step
          // re-runs on resume AND isParkedOnAskQuestionAwaitingReply recognizes
          // the park (see the normal await_reply path).
          await db.$transaction([
            db.workflowAwaitingReply.upsert({
              where: { runId: run.id },
              create: {
                workspaceId: wf.workspaceId,
                contactId: run.contactId,
                runId: run.id,
                workflowId: wf.id,
                stepId: node.id,
                expiresAt: resumeAt,
              },
              update: { stepId: node.id, expiresAt: resumeAt },
            }),
            db.workflowRun.update({
              where: { id: run.id },
              data: {
                status: "waiting",
                currentStepId: node.id,
                waitUntil: resumeAt,
                stepLog: stepLog as unknown as Prisma.InputJsonValue,
                jumpsUsed,
                pendingAnswer: Prisma.DbNull,
              },
            }),
          ]);
          await enqueueWorkflowResume(run.id, timeoutMs, stepLog.length);
          return { runId: run.id, status: "waiting" };
        }
      }
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
    // `isResume` is true only when the step is CURRENTLY parked on an
    // await_reply pause — its NEWEST stepLog entry (skipping the transient
    // `in_progress` sentinel just pushed above for side-effect steps) is
    // `waiting`. Reading the NEWEST entry — NOT "any prior waiting entry" — is
    // load-bearing: a step re-entered via jump_to_step AFTER it already resumed
    // to a terminal entry (the natural "re-ask on invalid answer" clarifier
    // loop: ask → timeout edge → send clarifier → jump back to ask) must re-run
    // as a fresh first call — re-send the question and await a genuinely new
    // reply — instead of being misread as a resume that never re-sends and
    // instantly re-consumes the now-stale pendingAnswer, spinning the loop into
    // duplicate WhatsApp sends until the execution ceiling fails the run. This
    // matches isParkedOnAskQuestionAwaitingReply's newest-entry signature.
    let isResume = false;
    for (let i = stepLog.length - 1; i >= 0; i--) {
      const entry = stepLog[i];
      if (entry?.stepId === node.id && entry.status !== "in_progress") {
        isResume = entry.status === "waiting";
        break;
      }
    }
    // An await_reply step (ask_question) resuming here CONSUMES run.pendingAnswer
    // when it advances; flag it so the post-step update clears the answer (both
    // in the DB and the in-memory snapshot) — otherwise a later re-entry
    // re-consumes the stale value. Mirrors the await_reply pause path's clear.
    const isAwaitReplyResume = isResume && producesAwaitReply(node.type);
    const pendingAnswer = (run.pendingAnswer ?? null) as
      | {
          body: string;
          messageId: string;
          timestamp: string;
          optionId?: string;
          optionKind?: "button_reply" | "list_reply";
        }
      | null;

    // 0-based execution ordinal of THIS step within the run: count of prior
    // SUCCESS entries for this stepId. Counting ONLY success is load-bearing:
    // http_request (the sole consumer) is sideEffect:"pure", so on a transient
    // throw the runner writes a terminal `failed` breadcrumb and BullMQ retries.
    // If that `failed` entry were counted, the ordinal would increment on the
    // very retry the X-CCP-Delivery key must stay STABLE across — changing the
    // key the partner dedupes on and double-charging (the exact bug the key
    // prevents). A transient-failed attempt writes `failed`, not `success`, so
    // the index is unchanged across retries; a genuinely COMPLETED loop iteration
    // (jump_to_step re-entry) writes `success`, so it still increments once per
    // iteration — distinct per re-entry, stable per execution.
    const executionIndex = stepLog.filter(
      (e) => e.stepId === node.id && e.status === "success",
    ).length;

    let result: StepResult;
    try {
      const config = handler.parseConfig(node.config);
      result = await handler.run(envelope, config, {
        workspaceId: wf.workspaceId,
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
        executionIndex,
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
            workspaceId: wf.workspaceId,
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
            // Pin currentStepId at THIS ask node — the same step re-runs on
            // resume, and isParkedOnAskQuestionAwaitingReply(currentStepId)
            // must resolve to it so an early inbound reply wakes the run
            // instead of being discarded as a stale resume. (Previously omitted,
            // leaving currentStepId at the upstream entry step.)
            currentStepId: node.id,
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
      // Per-step `maxJumps` cap: a loop author can bound how many times THIS
      // jump node fires for a run, tighter than the global ceiling. Count how
      // often this node has already jumped (prior success entries in stepLog
      // for this stepId+type) and, once at/over the cap, take the node's
      // fall-through edge instead of jumping again. Read maxJumps off the raw
      // node config (the parsed `config` is scoped to the try block above; the
      // jump handler's parseConfig already floors/validates this value, but we
      // re-read defensively since the raw shape is `unknown` here).
      const rawJumpConfig = (node.config ?? {}) as { maxJumps?: unknown };
      const maxJumps =
        typeof rawJumpConfig.maxJumps === "number" && rawJumpConfig.maxJumps > 0
          ? Math.floor(rawJumpConfig.maxJumps)
          : undefined;
      const priorJumpsThisNode = stepLog.filter(
        (e) => e.stepId === node.id && e.type === "jump_to_step" && e.status === "success",
      ).length;
      // Cap jumps per run at the global ceiling; a workflow that loops forever
      // should fail fast rather than chew the worker. Per-step maxJumps tightens
      // it further — this jump already counts as `priorJumpsThisNode + 1`.
      // A tripped ceiling must be VISIBLE. `jump_to_step` nodes normally have
      // no outgoing edge, so `findNextStep` returns null and the run used to
      // fall through to the "end of graph — completed" write: a runaway loop
      // reported SUCCESS, with a stepLog entry claiming it jumped to a target
      // it never went to. Record the reason and let the terminal-failure
      // branch below own the outcome (same shape as the per-pickup ceiling).
      if (jumpsUsed > MAX_STEPS_PER_RUN) {
        jumpCeilingHit = `jump ceiling (${MAX_STEPS_PER_RUN} jumps/run) exceeded — likely a jump_to_step loop`;
        nextId = findNextStep(graph, node.id);
      } else if (maxJumps !== undefined && priorJumpsThisNode + 1 > maxJumps) {
        jumpCeilingHit = `per-step jump cap (${maxJumps}) exceeded on step ${node.id}`;
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
        // Advance the persisted pointer at every step boundary. Without this
        // the DB `currentStepId` stayed pinned at the pickup's ENTRY step
        // through the whole forward run, so (a) a crash after this step's
        // success redelivered with currentStepId still upstream — re-running
        // this (already-committed, billed) send because orphan-detect had no
        // in_progress entry to catch, and (b) an ask_question further down
        // parked with currentStepId upstream, so isParkedOnAskQuestionAwaiting
        // Reply() couldn't recognize the park and early replies were dropped
        // until the 24h timeout (which then replayed the whole prefix). Keeping
        // it in lock-step with the in-memory `currentStepId = nextId` below is
        // what makes crash-redelivery land on the right step and lets the
        // orphan-detect / ask re-arm recovery work as designed.
        //
        // On the TERMINAL step nextId is null. Persisting null here is safe (and
        // correct — pinning the terminal node instead would re-run its committed
        // side effect on a redelivery, since its in_progress entry was already
        // spliced on success). The tiny crash window between this write and the
        // completion write below (status still "running", currentStepId now null)
        // is handled by the corruption guard (:303), which recognizes a
        // naturally-ended run and converges it to "completed" rather than failing.
        currentStepId: nextId,
        stepLog: stepLog as unknown as Prisma.InputJsonValue,
        stepOutputs: stepOutputs as unknown as Prisma.InputJsonValue,
        jumpsUsed,
        // An ask_question resume just consumed run.pendingAnswer as it advanced
        // down an edge — null it so a later re-entry (e.g. a jump_to_step
        // clarifier loop) re-asks and waits for a genuinely NEW reply instead
        // of instantly re-consuming this stale answer.
        ...(isAwaitReplyResume ? { pendingAnswer: Prisma.DbNull } : {}),
      },
    });
    // Keep the in-memory snapshot in sync so a same-pickup re-entry (jump back
    // to the ask node within this loop) reads a cleared pendingAnswer too.
    if (isAwaitReplyResume) run.pendingAnswer = null;

    previousStepId = node.id;
    currentStepId = nextId;
  }

  // Loop guard hit — record + FAIL the run. We exit the while with
  // `currentStepId` still set ONLY when a ceiling stopped us (the graph was
  // not yet terminal); a natural end-of-graph leaves currentStepId null. Two
  // ceilings can trip: the DISTINCT-step count (progressCount) and the
  // per-pickup EXECUTION count (executedThisPickup). The latter is what a
  // tight `jump_to_step` loop hits — it re-runs only a few distinct steps, so
  // progressCount stays low. The old check tested progressCount alone, so a
  // runaway jump loop fell through to the "completed" branch below, masking
  // the runaway AND nulling pending work as if the run finished cleanly.
  if (currentStepId || jumpCeilingHit) {
    const reason =
      jumpCeilingHit ??
      (progressCount(stepLog) >= MAX_STEPS_PER_RUN
        ? `step ceiling (${MAX_STEPS_PER_RUN}) exceeded`
        : `execution ceiling (${MAX_STEPS_PER_RUN} steps/pickup) exceeded — likely a jump_to_step loop`);
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
/**
 * True when the run is genuinely parked on an `ask_question` step awaiting an
 * inbound reply: `currentStepId` resolves to an `ask_question` node whose
 * NEWEST stepLog entry for that step is `waiting`. The await_reply path keeps
 * `currentStepId` on the same step and pushes a `waiting` entry, so this is the
 * exact parking signature.
 *
 * Used to gate the `isInboundResume` bypass of the not-due guard (see the
 * resume guard above). A dangling ask_question timeout job that wins the
 * reply≈timeout race — or any inbound pickup for a run that has since advanced
 * to a LATER wait step — fails this check and is treated as a stale resume,
 * preventing premature + double execution of post-wait steps. We deliberately
 * do NOT require a live WorkflowAwaitingReply row: the inbound ingest hook
 * deletes it (findAndConsumeAwaitingReplies) BEFORE enqueueing the resume job,
 * so it's always gone by the time this runs.
 */
function isParkedOnAskQuestionAwaitingReply(
  graph: WorkflowGraph,
  currentStepId: string | null,
  rawStepLog: unknown,
): boolean {
  if (!currentStepId) return false;
  const node = graph.nodes.find((n) => n.id === currentStepId);
  if (!node || node.type !== "ask_question") return false;
  const stepLog = Array.isArray(rawStepLog)
    ? (rawStepLog as StepLogEntry[])
    : [];
  // Walk backwards for the newest entry belonging to this step; it must be
  // `waiting` (the await_reply pause). A later `success`/`failed`/`skipped`
  // entry would mean the step already resumed and advanced.
  for (let i = stepLog.length - 1; i >= 0; i--) {
    const entry = stepLog[i];
    if (entry?.stepId === currentStepId) {
      return entry.status === "waiting";
    }
  }
  return false;
}

function hasSideEffect(type: WorkflowStepType): boolean {
  // Drive the answer from the per-handler `sideEffect` declaration so adding
  // a new step type forces the author to opt in/out at the type-system
  // level. The earlier hand-maintained string list silently classified
  // every new step as "pure" — exactly the regression vector CLAUDE.md
  // rule #3 (idempotent Meta sends) exists to prevent.
  // Wrapped like `producesAwaitReply` below: this is called while SCANNING A
  // STEP LOG, which can contain `{ type: "unknown" }` entries written by the
  // "node not found in graph" branch — and `getStepHandler` THROWS on those.
  // Unwrapped, that throw escaped the ledger rollback in the BullMQ processor
  // (whose `finally` doesn't catch), so a run with a dangling currentStepId
  // burned all three attempts, fired a false job-failure alarm, and left the
  // once-per-contact ledger held — locking that contact out of the workflow
  // permanently. `true` is the conservative answer: assume a side effect and
  // KEEP the ledger rather than releasing it on a step we can't classify.
  try {
    return getStepHandler(type).sideEffect === "irreversible";
  } catch {
    return true;
  }
}

// WF-2: a step that PAUSES for a contact reply (ask_question). Drives the
// runner's crash-recovery RE-ARM branch — see the orphan-detect path.
function producesAwaitReply(type: WorkflowStepType): boolean {
  try {
    return getStepHandler(type).awaitReply === true;
  } catch {
    return false;
  }
}

function buildEnvelope(
  workspaceId: string,
  trigger: WorkflowTriggerEvent,
  payload: unknown,
): WorkflowEventEnvelope {
  const p = payload as {
    conversation?: { id?: string };
    contact?: { id?: string };
    _depth?: unknown;
    _workflowDepth?: unknown;
  };
  const conversationId = p?.conversation?.id ?? "";
  const contactId = p?.contact?.id ?? "";
  // Cross-system chain depth — seeded by the incoming_webhook handler from the
  // inbound X-CCP-Depth header (stored on the run's eventPayload as `_depth`).
  // 0 for every other trigger. The http_request step reads this off the
  // envelope and stamps depth+1 on its outbound call.
  const depth = typeof p?._depth === "number" && Number.isFinite(p._depth) ? p._depth : 0;
  // Workflow-chain depth — incremented by `trigger_workflow` step on each
  // chained dispatch. Stored on every chained run's eventPayload regardless
  // of which trigger event the chained workflow listens to. Without this,
  // a chain `messageReceived → trigger_workflow → workflow B (any trigger)
  // → trigger_workflow → workflow C → …` would reset the workflow-chain
  // counter to 0 at every non-`manual_trigger` hop, bypassing
  // TRIGGER_DEPTH_MAX. Top-level user-initiated runs carry no field and
  // start at 0; chained runs carry the parent's depth.
  const workflowDepth =
    typeof p?._workflowDepth === "number" && Number.isFinite(p._workflowDepth)
      ? p._workflowDepth
      : 0;
  const base = process.env.APP_PUBLIC_URL ?? "http://localhost:3000";
  return {
    version: 1,
    event: trigger,
    workspaceId,
    occurredAt: new Date().toISOString(),
    data: payload as WorkflowEventEnvelope["data"],
    depth,
    workflowDepth,
    _links: {
      conversation: `${base}/api/external/v1/conversations/${conversationId}`,
      messages: `${base}/api/external/v1/conversations/${conversationId}/messages`,
      contact: `${base}/api/external/v1/contacts/${contactId}`,
    },
  };
}

/**
 * Re-read the trigger message's media links from the DB and overlay them onto
 * `envelope.data.message` so `$var.message.media_url` resolves to the live CDN
 * URL even though the trigger-time snapshot was built before the async media
 * download finished (see CLAUDE.md "Inbound media downloads ASYNC"). Mirrors
 * the outbound-webhooks subscriber's `enrichMessages`. Mutates the envelope in
 * place; best-effort — a missing row or a not-yet-completed download leaves the
 * existing values untouched. No-op for triggers that carry no message snapshot.
 */
async function rehydrateMessageMedia(envelope: WorkflowEventEnvelope): Promise<void> {
  const data = envelope.data as {
    message?: {
      id?: string;
      mediaKind?: string | null;
      mediaUrl?: string | null;
      mediaThumbnailUrl?: string | null;
    };
  };
  const message = data.message;
  // Text-only messages can never have a media URL — skip the PK lookup entirely.
  // mediaKind rides the pinned snapshot, so this gate costs nothing and spares
  // every text run (and each wait/resume) a needless read.
  if (!message?.id || message.mediaKind == null) return;
  try {
    const row = await db.message.findUnique({
      where: { id: message.id },
      select: { mediaUrl: true, mediaThumbnailUrl: true },
    });
    if (!row) return;
    // Only overlay when the DB has a value — never blank out a snapshot URL
    // the publisher already managed to populate (the snapshot can win the
    // race for outbound sends where the URL is known at publish time).
    if (row.mediaUrl != null) message.mediaUrl = row.mediaUrl;
    if (row.mediaThumbnailUrl != null) message.mediaThumbnailUrl = row.mediaThumbnailUrl;
  } catch {
    // Best-effort enrichment — a read failure must not abort the run.
  }
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
      select: {
        id: true,
        workspaceId: true,
        workflowId: true,
        contactId: true,
        status: true,
        stepLog: true,
      },
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
    // WF-1: a terminally-failed once-per-contact run releases its ledger row so
    // the workflow can re-fire for this contact — UNLESS an irreversible side
    // effect already fired (WF-1b), in which case the ledger stays to prevent a
    // double-send on the next trigger.
    await rollbackOncePerContactLedger(
      run.workspaceId,
      run.workflowId,
      run.contactId,
      run.stepLog,
    );
  } catch (err) {
    console.warn(
      `[workflow-runner] failRunFromRetryExhaustion(${runId}) threw:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * WF-1: when a once-per-contact run terminally FAILS, drop its
 * `WorkflowContactState` ledger row so the workflow can re-fire for that contact
 * on a future trigger instead of being locked out forever. The ledger row is
 * committed BEFORE execution (dispatcher.ts), so without this a run that fails
 * on its first step (transient Meta outage, config typo, retry exhaustion)
 * marks the contact "already fired" permanently + invisibly. Keyed on
 * (workflowId, contactId) — a no-op for non-once-per-contact runs (no ledger
 * row exists) and for runs with no contact. Best-effort; never throws.
 */
/**
 * True when the failed run ALREADY fired (or is presumed to have fired) an
 * irreversible side effect — a `success` / `in_progress` / `skipped_after_crash`
 * entry on a side-effecting step (Meta send, tag/status/field mutation). If one
 * exists we must NOT release the once-per-contact ledger: re-firing the whole
 * graph on the next trigger would double-send. "Locked out" is the correct
 * trade over "duplicate irreversible send" — matches the runner's own
 * orphan-`in_progress` → skip-not-rerun posture.
 */
function runFiredIrreversibleSideEffect(stepLog: StepLogEntry[]): boolean {
  return stepLog.some(
    (e) =>
      (e.status === "success" ||
        e.status === "in_progress" ||
        e.status === "skipped_after_crash") &&
      hasSideEffect(e.type as WorkflowStepType),
  );
}

export async function rollbackOncePerContactLedger(
  workspaceId: string,
  workflowId: string,
  contactId: string | null,
  stepLogJson?: unknown,
): Promise<void> {
  if (!contactId) return;
  // Keep the ledger when an irreversible side effect already fired in this run
  // (WF-1b): releasing it would let the next trigger re-run the whole graph and
  // double-send. A run that failed BEFORE any side effect (transient outage on
  // step 1, config typo, or a never-executed unpublished/deleted run with an
  // empty stepLog) safely releases. `stepLogJson` is the raw WorkflowRun.stepLog
  // JSON; absent (undefined) preserves the legacy always-release behavior.
  const stepLog: StepLogEntry[] = Array.isArray(stepLogJson)
    ? (stepLogJson as unknown as StepLogEntry[])
    : [];
  if (runFiredIrreversibleSideEffect(stepLog)) {
    return;
  }
  try {
    await db.workflowContactState.deleteMany({ where: { workspaceId, workflowId, contactId } });
  } catch (err) {
    console.warn(
      `[workflow-runner] rollbackOncePerContactLedger(${workflowId}, ${contactId}) threw:`,
      err instanceof Error ? err.message : err,
    );
  }
}
