"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Clock,
  Loader2,
  X,
  XCircle,
} from "lucide-react";

import { cn } from "@ccp/shared/utils";
import { apiFetch } from "@/lib/api/client-fetch";

import { type WorkflowGraph, STEP_OPTIONS } from "./types";

/**
 * Test-run result drawer. Opens after "Test" enqueues a run; polls
 * `GET /api/team/workflows/:id/runs/:runId` until the run reaches a terminal
 * state, then shows the overall outcome + a per-step PASS/FAIL log with each
 * step's output (responseStatus/body) or error inline.
 *
 * Replaces the old raw-runId banner — an admin can now validate a draft
 * end-to-end before flipping it Live without leaving the builder.
 *
 * Polling, not sockets: a test run finishes in a couple of seconds and the
 * builder has no run-room subscription; a short poll is the simplest thing
 * that converges. `waiting` (parked on an ask_question) is treated as
 * terminal-for-polling so we don't poll forever on a reply that may never
 * come — it's surfaced as its own distinct status.
 */

// Mirrors StepLogEntry in apps/api/src/lib/workflows/runner.ts.
interface StepLogEntry {
  stepId: string;
  type: string;
  status: "in_progress" | "success" | "failed" | "waiting" | "skipped_after_crash";
  attempt?: number;
  startedAt: string;
  finishedAt?: string;
  responseStatus?: number;
  responseBody?: string;
  errorMessage?: string;
  nextStepId?: string | null;
}

// Mirrors WorkflowRunStatus (prisma) + the getRun DTO.
type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "skipped";

interface RunDetail {
  id: string;
  status: RunStatus;
  currentStepId: string | null;
  errorMessage: string | null;
  stepLog: StepLogEntry[] | null;
  startedAt: string;
  finishedAt: string | null;
}

const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "skipped", "waiting"]);

interface Props {
  workflowId: string;
  runId: string;
  /** Live graph — maps a stepLog entry's stepId to the author's node name. */
  graph: WorkflowGraph;
  onClose: () => void;
}

export function TestRunDrawer({ workflowId, runId, graph, onClose }: Props) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setRun(null);
    setError(null);

    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelledRef.current) return;
      try {
        const res = await apiFetch(
          `/api/team/workflows/${workflowId}/runs/${runId}`,
        );
        if (cancelledRef.current) return;
        if (!res.ok) {
          setError(`Couldn't load run (${res.status}).`);
          return;
        }
        const json = (await res.json()) as RunDetail;
        if (cancelledRef.current) return;
        setRun(json);
        if (!TERMINAL.has(json.status)) {
          timer = setTimeout(poll, 1200);
        }
      } catch {
        if (cancelledRef.current) return;
        // Transient network blip — keep polling rather than dead-end.
        timer = setTimeout(poll, 1500);
      }
    }
    void poll();

    return () => {
      cancelledRef.current = true;
      if (timer) clearTimeout(timer);
    };
  }, [workflowId, runId]);

  const steps = run?.stepLog ?? [];
  const isRunning = !run || !TERMINAL.has(run.status);
  // First step the runner flagged as failed, for the headline summary.
  const failedStep = steps.find(
    (s) => s.status === "failed" || s.status === "skipped_after_crash",
  );

  return (
    <aside className="flex h-full w-[min(22rem,85vw)] shrink-0 flex-col border-l border-border bg-card sm:w-[26rem]">
      <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-3xs font-medium uppercase tracking-wider text-muted-foreground">
            Test result
          </div>
          <div className="truncate text-sm font-semibold text-foreground">
            {isRunning ? "Running…" : headlineFor(run!, failedStep, graph)}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Close test result"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <StatusBanner running={isRunning} status={run?.status ?? null} />

        {error && (
          <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-2xs text-destructive">
            {error}
          </div>
        )}

        {steps.length > 0 ? (
          <ol className="mt-3 flex flex-col gap-1.5">
            {steps.map((step, i) => (
              <StepRow
                key={`${step.stepId}-${i}`}
                index={i + 1}
                step={step}
                graph={graph}
              />
            ))}
          </ol>
        ) : (
          !error &&
          !isRunning && (
            <div className="mt-3 text-2xs text-muted-foreground">
              No steps ran — the trigger conditions matched but the graph had
              nothing to execute.
            </div>
          )
        )}

        {isRunning && steps.length === 0 && !error && (
          <div className="mt-3 flex items-center gap-2 text-2xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Waiting for the first step…
          </div>
        )}
      </div>
    </aside>
  );
}

function headlineFor(
  run: RunDetail,
  failedStep: StepLogEntry | undefined,
  graph: WorkflowGraph,
): string {
  switch (run.status) {
    case "completed":
      return "Succeeded";
    case "failed":
      return failedStep
        ? `Failed at ${stepLabel(failedStep, graph)}`
        : "Failed";
    case "skipped":
      return "Skipped — trigger conditions didn't match";
    case "waiting":
      return "Waiting for a reply";
    default:
      return "Running…";
  }
}

function StatusBanner({
  running,
  status,
}: {
  running: boolean;
  status: RunStatus | null;
}) {
  if (running) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-2xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Running the workflow against a test contact…
      </div>
    );
  }
  const tone =
    status === "completed"
      ? "border-success-border bg-success-bg text-success-fg"
      : status === "failed"
        ? "border-destructive/30 bg-destructive/5 text-destructive"
        : "border-border bg-muted/40 text-muted-foreground";
  const Icon =
    status === "completed"
      ? CheckCircle2
      : status === "failed"
        ? XCircle
        : status === "waiting"
          ? Clock
          : CircleSlash;
  const label =
    status === "completed"
      ? "Workflow succeeded"
      : status === "failed"
        ? "Workflow failed"
        : status === "waiting"
          ? "Paused — waiting for a contact reply"
          : "Skipped — trigger conditions didn't match";
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-2xs font-medium",
        tone,
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {label}
    </div>
  );
}

function StepRow({
  index,
  step,
  graph,
}: {
  index: number;
  step: StepLogEntry;
  graph: WorkflowGraph;
}) {
  const failed = step.status === "failed" || step.status === "skipped_after_crash";
  const pending = step.status === "in_progress";
  const waiting = step.status === "waiting";
  const hasDetail =
    Boolean(step.errorMessage) ||
    Boolean(step.responseBody) ||
    typeof step.responseStatus === "number";
  const [open, setOpen] = useState(failed);

  const StatusIcon = failed
    ? XCircle
    : waiting
      ? Clock
      : pending
        ? Loader2
        : CheckCircle2;
  const iconClass = failed
    ? "text-destructive"
    : waiting
      ? "text-muted-foreground"
      : pending
        ? "animate-spin text-muted-foreground"
        : "text-success-fg";

  return (
    <li className="rounded-lg border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        disabled={!hasDetail}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
          hasDetail ? "cursor-pointer hover:bg-accent/40" : "cursor-default",
        )}
      >
        <span className="text-3xs tabular-nums text-muted-foreground/70">
          {index}
        </span>
        <StatusIcon className={cn("size-3.5 shrink-0", iconClass)} />
        <span className="min-w-0 flex-1 truncate text-2xs font-medium text-foreground">
          {stepLabel(step, graph)}
        </span>
        {step.status === "skipped_after_crash" && (
          <AlertTriangle
            className="size-3 shrink-0 text-muted-foreground"
            aria-label="Presumed sent — verify manually"
          />
        )}
        {typeof step.responseStatus === "number" && (
          <span className="shrink-0 text-3xs tabular-nums text-muted-foreground/70">
            {step.responseStatus}
          </span>
        )}
        {hasDetail &&
          (open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          ))}
      </button>

      {open && hasDetail && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2">
          {step.status === "skipped_after_crash" && (
            <div className="text-3xs text-muted-foreground">
              Worker restarted mid-step — presumed sent, advanced without
              re-running. Verify manually.
            </div>
          )}
          {step.errorMessage && (
            <DetailBlock label="Error" tone="error" value={step.errorMessage} />
          )}
          {step.responseBody && (
            <DetailBlock label="Output" value={step.responseBody} />
          )}
        </div>
      )}
    </li>
  );
}

function DetailBlock({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "error";
}) {
  return (
    <div>
      <div className="pb-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        {label}
      </div>
      <pre
        className={cn(
          "max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border px-2 py-1.5 font-mono text-3xs",
          tone === "error"
            ? "border-destructive/30 bg-destructive/5 text-destructive"
            : "border-border/70 bg-background/60 text-foreground",
        )}
      >
        {prettyMaybeJson(value)}
      </pre>
    </div>
  );
}

/** Author node name → step type label → bare stepId, in that order. */
function stepLabel(step: StepLogEntry, graph: WorkflowGraph): string {
  const node = graph.nodes.find((n) => n.id === step.stepId);
  if (node?.name?.trim()) return node.name.trim();
  const meta = STEP_OPTIONS.find((s) => s.value === step.type);
  return meta?.label ?? step.type ?? step.stepId.slice(0, 8);
}

/** Pretty-print a JSON string; fall back to the raw string when it isn't JSON. */
function prettyMaybeJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
