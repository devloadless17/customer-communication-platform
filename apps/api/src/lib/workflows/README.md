# Workflow engine

Multi-step business processes — assign + tag + send a template when a contact
matches a trigger — modelled as a directed graph of typed steps, executed by
a BullMQ worker, with state persisted to Postgres between every step.

Workflow definitions are stored in the database (the `Workflow` table). Admins
author them in the React Flow canvas; the engine doesn't know they exist until
a Domain Event fires that matches a workflow's trigger.

## Where state lives during execution

This is the question that matters when something goes wrong at 2 a.m. Every
field below is the single source of truth for what it carries.

| State                                    | Lives in                       | Lifetime                  |
|------------------------------------------|--------------------------------|---------------------------|
| Workflow definition (graph, trigger)     | `Workflow` table                | Until admin deletes       |
| Run identity + which step is next        | `WorkflowRun.currentStepId`     | Until run completes/fails |
| Per-step audit + responses               | `WorkflowRun.stepLog` (JSONB)   | Forever (append-only)     |
| Jump counter (loop guard)                | `WorkflowRun.jumpsUsed`         | Until run completes/fails |
| Run status                               | `WorkflowRun.status`            | Updated after each step   |
| Trigger payload (what fired this run)    | `WorkflowRun.eventPayload`      | Forever                   |
| "Resume after T" delay                   | BullMQ delayed job (workflows queue) | Until job fires       |
| Step handler config (e.g. "assign to X") | Workflow graph node            | Read fresh per step       |
| Bus subscribers + dispatcher mappings    | Process memory (registered at boot) | Process lifetime     |

There is **no in-memory run state**. The runner reads `WorkflowRun` at the
top of every pickup and writes the row at every transition. A process restart
mid-run loses nothing: the same run continues on the next worker pickup from
its persisted `currentStepId`.

## Job/queue model

One queue (`workflows`) carries one job shape (`{ runId: string }`). Two
job kinds share it, distinguished only by their `delay`:

- **Initial run**  — `enqueueWorkflowRun(runId)`, fired by
  `WorkflowDispatcherService` when a matching DomainEvent reaches the bus.
- **Resume after wait** — `enqueueWorkflowResume(runId, delayMs)`, fired by
  the runner itself when a step returns `{ kind: "wait", delayMs }`. BullMQ's
  delayed-job feature handles the timer; survives worker restarts.

Worker concurrency: `WORKFLOW_WORKER_CONCURRENCY` env (default 5). That's how
many runs can execute in parallel inside a single api process. The current
default is sized for pilot traffic; bump after measuring.

## Idempotency posture

**Per-step DB writes are atomic.** Every step that touches the DB does it in
a single Prisma statement (or a single `$transaction`). A BullMQ retry replays
the step from the top, and the DB-side write is harmless on the second run:
either `update` is a no-op because the field already has that value, or the
`upsert` matches the same row.

**Cross-step crash safety.** The pathology this design has to survive:

1. Step N runs an external call (e.g. Meta API: send a WhatsApp template).
2. The external side accepts the call and returns 200.
3. The runner crashes before the "step N succeeded" row update commits.
4. BullMQ retries the job with `currentStepId` still pointing at step N.

Naively that re-sends. It does NOT here: the runner **journals** an
`in_progress` stepLog entry BEFORE every step whose handler declares
`sideEffect: "irreversible"`, and on the next pickup an `in_progress` entry
for the current step is recognised as an orphan — the runner writes
`skipped_after_crash` and ADVANCES instead of re-running (`runner.ts`, the
orphan-detect path). Duplicate billed sends from a crash are therefore
prevented, not tolerated.

What remains at-least-once by design:

- **send-message / send-template / ask-question** — protected by the journal
  above; a crash in the narrow window before the journal commits can still
  re-send. These bypass the `OutboundSendAttempt` ledger the composer/API
  sends use.
- **assign-to / tag / set-status / update-field / update-lifecycle / ticket
  steps** — DB-side idempotent or CAS-guarded (same write twice = same
  result).
- **http-request** — `sideEffect: "pure"`, and it stamps a stable
  `X-CCP-Delivery` (`runId:stepId:executionIndex`) so the RECEIVER can dedupe.

Separately, DISPATCH is deduped: since the outbox became at-least-once, a
redelivered domain event would otherwise create a second `WorkflowRun` and
re-execute the whole graph. `WorkflowRun.eventKey`
(`outboxRowId:workflowId:trigger:contactId:discriminator`, partial unique)
makes the replay a no-op (`dispatcher.ts`).

## Loop guards

Two ceilings on `MAX_STEPS_PER_RUN` (= `MAX_WORKFLOW_NODES` = 200, the
publish-time node cap in `graph.ts`):

1. **Total steps across all pickups for one run** — `stepLog.length`. A run
   that wakes from a wait into a loop can't chew the queue forever.
2. **Per-pickup steps** — `executedThisPickup`. A single resumption can't
   monopolise the worker; if a `wait` step keeps misfiring, the second
   pickup hits this ceiling and the run is marked failed.

`jumpsUsed` counts `jump_to_step` executions separately and is capped at the
same ceiling, so a graph designed to loop via jumps fails before the global
step count does.

## Failure modes

| Failure                                | Outcome                                |
|----------------------------------------|----------------------------------------|
| Step throws `UnknownStepTypeError`     | Run fails immediately (no retry).      |
| Step throws `StepConfigError`          | Run fails immediately (no retry).      |
| Step throws anything else              | BullMQ retries with exponential backoff. The failing attempt's `stepLog` entry is persisted before the throw, so the UI shows the cause across retries. |
| Worker process crashes mid-step        | BullMQ marks the job failed-on-restart and retries; the runner re-reads the row and resumes from `currentStepId`. The per-run mutex TTL (`RUN_LOCK_TTL_MS`, 60s) is boot-asserted below the BullMQ job lock (`WORKFLOW_LOCK_DURATION_MS`, 90s) so the dead lane's run-lock has usually expired before the redelivery lands — the retry reacquires it and resumes instead of no-op-skipping into a permanent `running` strand. The residual window (BullMQ renews its job lock mid-flight, so a redelivery can arrive a few seconds before the run-lock expires and `skipped`-completes) is closed by the waiting-sweeper's **`running` backstop**: a `running` row with no per-run lock held = a dead lane, so it re-enqueues the run (`workflow-waiting.ts`). |
| Workflow disabled while running        | Next pickup marks the run "skipped" and exits cleanly. |
| `MAX_STEPS_PER_RUN` exceeded           | Run marked failed with `errorMessage: "step ceiling exceeded"`. |

Runs ARE reconciled, unlike the original design note here claimed: the
waiting sweeper (`sweepers/workflow-waiting.ts`) carries a **`running`
backstop** (a `running` row whose per-run lock is gone = a dead lane →
re-enqueue) and a **`queued` backstop** (`strandedQueued`: a run created but
never enqueued, e.g. a crash between the row insert and the Redis enqueue, or
a P2002-deduped redelivery that legitimately skipped the enqueue). So a run
stranded by a rough deploy self-heals within a sweep rather than sitting
`running` forever.

## Layout

```
apps/api/src/workflows/                ← NestJS layer (DI-aware)
  workflow-worker.service.ts             starts/stops the BullMQ worker
                                         based on RUN_WORKER_INLINE
  workflow-subscribers.service.ts        registers DomainEvent bus subs
  workflow-dispatcher.service.ts         matches events → workflows
  workflows.module.ts                    wires the above

apps/api/src/lib/workflows/            ← framework-agnostic engine
  README.md                              ← this file
  runner.ts                              DAG executor — pickup loop, step
                                         dispatch, state transitions
  worker.ts                              BullMQ Worker bootstrap
  queue.ts                               BullMQ Queue + Redis connection
  graph.ts                               graph parse + traversal helpers
  parse.ts                               WorkflowBody parse + redact for
                                         API responses
  conditions.ts                          branch step expression eval
  events.ts                              WorkflowEventEnvelope type +
                                         per-trigger payload shapes
  dispatcher.ts                          event → workflow matching logic,
                                         incl. the redelivery dedupe key
  resume-on-inbound.ts                   claims WorkflowAwaitingReply rows
                                         (DELETE … RETURNING) when a contact
                                         replies to an ask_question
  branch-presets.ts                      the branch step's preset predicates
  steps/
    types.ts                             StepHandler + StepResult contracts
    index.ts                             handler registry
    target.ts                            resolves a step's contact/conversation
    token-context.ts                     live token/{{var}} resolution
    {tag,assign-to,set-status,add-comment,
     update-field,update-lifecycle,
     send-message,send-template,
     ask-question,ticket,noop,
     open-close-conversation,
     control-flow,http-request,
     trigger-workflow}.ts                handlers (one per step type)
```

The NestJS layer above is the boot/DI seam. The actual engine — runner,
worker, queue, steps, graph parse — is plain TypeScript with no NestJS
imports. That's deliberate: nothing in here cares about the request
context, so DI would be ceremony with no payoff.

## When to split the queue

Single queue is right today. The trigger for splitting:

**A single slow step starves fast jobs.** The first plausible candidate is
an AI step (LLM call, 5–30s p99). With concurrency 5 and one AI workflow
running with delays in the middle, all five workers can land on the AI step
simultaneously; nothing else moves until those calls finish.

Resolution at that point: a second queue (`workflows:slow`) with its own
worker pool, and a step-handler property like `slowOp: true` that makes the
runner enqueue a continuation on the slow queue instead of running inline.
Do NOT pre-build this — until the first slow step exists, sizing the slow
worker pool is guesswork.

## Adding a new step type

1. Add a file under `steps/` exporting a `StepHandler`.
2. Register it in `steps/index.ts` so `getStepHandler(type)` finds it.
3. Add the step type to the React Flow palette in the canvas UI
   (`apps/web/src/features/workflows/...`).
4. If the step has side effects, document the idempotency posture in the
   handler's file header — say what happens on a retry.

Don't reach into `WorkflowRun` directly from the handler. The runner owns
`stepLog`, `currentStepId`, and `status` writes; the handler should only
read the envelope and return a `StepResult`.
