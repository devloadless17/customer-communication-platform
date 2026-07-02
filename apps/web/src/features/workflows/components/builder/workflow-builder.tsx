"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useSoftRefresh } from "@/hooks/use-soft-refresh";
import {
  ArrowUpRight,
  Loader2,
  PlayCircle,
  Power,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";

import { ensureConditionIds, stripConditionIds } from "./condition-group";
import { StepEditorDrawer } from "./step-editor-drawer";
import { TestRunDrawer } from "./test-run-drawer";
import { TriggerEditorDrawer } from "./trigger-editor-drawer";
// Pure graph helpers — import from the standalone module so this shell does
// not pull in `@xyflow/react` (the canvas's heavy dep) at module-eval time.
import {
  type AskOptionEdgeOp,
  countDisconnectedByRemoval,
  duplicateStep,
  insertStepAfter,
  removeAllOptionEdges,
  removeOptionEdge,
  removeStep,
  renameOptionEdge,
} from "./graph-mutations";
import type { WorkflowCanvasProps } from "./workflow-canvas";
import {
  type BuilderCatalogs,
  type ConditionGroup,
  type StepType,
  type Trigger,
  type WorkflowGraph,
  TRIGGER_OPTIONS,
  toGroup,
} from "./types";

// Lazy-load the React Flow canvas — it pulls in `@xyflow/react` (~150 KB
// gzipped including its CSS) and is the heaviest dep on the workflow route.
// `ssr: false` because React Flow measures the DOM on mount; SSRing it would
// only produce a flicker placeholder anyway. The lightweight skeleton below
// renders the moment the page navigates, so the chrome (header / drawers)
// shows immediately and the canvas streams in after.
const WorkflowCanvas = dynamic<WorkflowCanvasProps>(
  () => import("./workflow-canvas").then((mod) => mod.WorkflowCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-gradient-to-b from-background to-muted/10 text-xs text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading canvas...
      </div>
    ),
  },
);

/**
 * Top-level workflow builder. Layout:
 *
 *   ┌─────────┬───────────────────────┬─────────────┐
 *   │ palette │       canvas           │   drawer    │
 *   │ (left)  │ (React Flow, center)   │  (right)    │
 *   └─────────┴───────────────────────┴─────────────┘
 *
 *   - Palette is always visible (drag-and-click to add steps)
 *   - Drawer is contextual: opens when the user selects a node OR clicks
 *     the trigger card. Closes via X / Escape / clicking the canvas pane.
 *   - Top bar carries name + Draft↔Live toggle + Save/Test buttons.
 */

interface InitialWorkflow {
  id: string;
  name: string;
  published: boolean;
  trigger: Trigger;
  triggerConfig: Record<string, unknown>;
  triggerConditions: unknown;
  triggerOncePerContact: boolean;
  graph: WorkflowGraph;
}

interface Props {
  mode: "create" | "edit";
  catalogs: BuilderCatalogs;
  workflow?: InitialWorkflow;
}

export function WorkflowBuilder({ mode, catalogs, workflow }: Props) {
  const router = useRouter();
  const softRefresh = useSoftRefresh();
  const { confirm, confirmDialog } = useConfirm();

  const [name, setName] = useState(workflow?.name ?? "Untitled workflow");
  const [published, setPublished] = useState(workflow?.published ?? false);
  const [trigger, setTrigger] = useState<Trigger>(workflow?.trigger ?? "message_received");
  const [triggerConfig, setTriggerConfig] = useState<Record<string, unknown>>(
    workflow?.triggerConfig ?? {},
  );
  const [triggerConditions, setTriggerConditions] = useState<ConditionGroup>(() =>
    // Stamp stable _id on hydrated rows ONCE, off the render path (render must
    // never mutate state — that leaked _id into the persisted DB JSON).
    ensureConditionIds(toGroup(workflow?.triggerConditions)),
  );
  const [triggerOncePerContact, setTriggerOncePerContact] = useState(
    workflow?.triggerOncePerContact ?? false,
  );
  const [graph, setGraph] = useState<WorkflowGraph>(
    workflow?.graph ?? { startNodeId: "", nodes: [], edges: [] },
  );

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [triggerOpen, setTriggerOpen] = useState(false);

  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});
  const [topErrors, setTopErrors] = useState<string[]>([]);
  // Non-blocking mid-build incompleteness (unwired Branch / ask_question
  // outputs). Returned by create/update's SAVE tier; the save still succeeds.
  // Cleared/refreshed on every persist; publish surfaces the same conditions
  // as hard errors in topErrors instead.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  // Enqueue-failure banner only (the success path opens the result drawer).
  const [testError, setTestError] = useState<string | null>(null);
  // Open test-run result drawer is keyed by runId; null = closed.
  const [testRunId, setTestRunId] = useState<string | null>(null);

  // In-flight save AbortController. Aborted on unmount + before each
  // fresh save so a slow PATCH from a few keystrokes ago can't land
  // setState into an unmounted (or navigated-away) component, and a
  // freshly-typed change supersedes the prior save without two replies
  // racing into setTopErrors / setStepErrors.
  const persistCtlRef = useRef<AbortController | null>(null);

  // Edit-mode unsaved-edit tracker (mirrors createDirtyRef). The auto-save deps
  // changing = "user edited something not yet persisted"; cleared in persist()
  // success. Drives the Exit flush so the debounced save isn't dropped on nav.
  const dirtyRef = useRef(false);
  const navMountedRef = useRef(false);
  // True while an explicit Exit flush is awaiting persist(), so the debounce
  // timer can't fire a competing save that aborts the flush's AbortController.
  const exitingRef = useRef(false);
  const [exiting, setExiting] = useState(false);
  // Same guard for the OTHER explicit persists (Save / Test / Live-toggle):
  // each `await persist(...)` those handlers rely on would silently return
  // false if the 1.5s debounce fired mid-flight and aborted its controller —
  // so the follow-up (open test drawer, POST /publish) never ran. Set around
  // the awaited persist; the debounce below skips while it's true.
  const explicitPersistRef = useRef(false);

  // Auto-save in edit mode. Cheap (~one PATCH per couple seconds of
  // idle); the alternative — manual save button only — leads to "I lost
  // my changes" frustration when the tab crashes. We skip the auto-save
  // in create mode since there's no row to PATCH yet.
  useEffect(() => {
    if (mode !== "edit" || !workflow) return;
    const handle = setTimeout(() => {
      // Don't let the debounce restart a save that would abort an in-flight
      // explicit persist's controller — Exit flush (exitingRef) OR Save / Test
      // / Live-toggle (explicitPersistRef). Aborting any of them makes their
      // awaited persist() return false and their follow-up action never run.
      if (exitingRef.current || explicitPersistRef.current) return;
      void persist({ silent: true });
    }, 1500);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, trigger, triggerConfig, triggerConditions, triggerOncePerContact, graph]);

  // Unmount: cancel any in-flight save so its .then() / setState calls
  // don't run after the builder is gone (navigated to /workflows list).
  useEffect(
    () => () => {
      persistCtlRef.current?.abort();
    },
    [],
  );

  // Create-mode unsaved-work guard. Edit mode auto-saves (above); create mode
  // has no row to PATCH yet, so a full trigger+graph built on /workflows/new is
  // otherwise lost on refresh / tab-close / external nav with no warning. Track
  // a dirty flag (skipping the initial mount render) and prompt on beforeunload.
  const createDirtyRef = useRef(false);
  const createMountedRef = useRef(false);
  useEffect(() => {
    if (mode === "edit") return;
    if (!createMountedRef.current) {
      createMountedRef.current = true;
      return;
    }
    createDirtyRef.current = true;
  }, [mode, name, trigger, triggerConfig, triggerConditions, triggerOncePerContact, graph]);
  useEffect(() => {
    if (mode === "edit") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!createDirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [mode]);

  // Edit-mode dirty tracker (skip the mount render). Same deps as the auto-save
  // debounce — a dep change means there are edits not yet persisted. handleExit
  // flushes a pending save before navigating when this is set.
  useEffect(() => {
    if (mode !== "edit") return;
    if (!navMountedRef.current) {
      navMountedRef.current = true;
      return;
    }
    dirtyRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, trigger, triggerConfig, triggerConditions, triggerOncePerContact, graph]);

  async function persist(opts: { silent?: boolean } = {}): Promise<boolean> {
    // Supersede any in-flight save — freshest input wins, prior
    // response is ignored on its way back.
    persistCtlRef.current?.abort();
    const ctl = new AbortController();
    persistCtlRef.current = ctl;

    // Strip client-only `_id` from BOTH condition surfaces before sending —
    // trigger-level conditions AND every branch step's config.conditions — so
    // the non-wire keys never reach the DB JSON. This is the single
    // serialization choke point for create(POST) + edit(PATCH).
    const cleanGraph: WorkflowGraph = {
      ...graph,
      nodes: graph.nodes.map((n) => {
        const conds = (n.config as { conditions?: unknown } | undefined)
          ?.conditions;
        if (!conds) return n;
        return {
          ...n,
          config: { ...n.config, conditions: stripConditionIds(toGroup(conds)) },
        };
      }),
    };
    const body = {
      name,
      trigger,
      triggerConfig,
      triggerConditions: stripConditionIds(triggerConditions),
      triggerOncePerContact,
      graph: cleanGraph,
    };
    const path =
      mode === "create"
        ? "/api/team/workflows"
        : `/api/team/workflows/${workflow!.id}`;
    const method = mode === "create" ? "POST" : "PATCH";
    let res: Response;
    try {
      res = await apiFetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (err) {
      // Aborted (next save kicked in / unmount) → bail silently; the
      // newer save (or no save) is the authoritative outcome.
      if (ctl.signal.aborted) return false;
      throw err;
    }
    if (ctl.signal.aborted) return false;
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      error?: string;
      details?: string[];
      stepErrors?: Record<string, string>;
      warnings?: string[];
    };
    if (ctl.signal.aborted) return false;
    if (!res.ok) {
      setTopErrors(json.details ?? [json.error ?? `error ${res.status}`]);
      if (json.stepErrors) setStepErrors(json.stepErrors);
      return false;
    }
    setTopErrors([]);
    setStepErrors({});
    setWarnings(json.warnings ?? []);
    dirtyRef.current = false; // saved — nothing for the Exit flush to push
    if (mode === "create" && json.id) {
      router.push(`/workflows/${json.id}`);
    } else if (!opts.silent) {
      softRefresh();
    }
    return true;
  }

  // Exit flushes a pending edit-mode save before leaving. The debounce's
  // unmount cleanup clearTimeouts the queued save (so it never starts) and the
  // unmount effect aborts an in-flight one — both drop the last ~1.5s of edits
  // on a plain <Link> nav. So flush proactively. Create mode just navigates
  // (no row to PATCH; it has its own beforeunload guard).
  async function handleExit() {
    if (exiting) return;
    if (mode === "edit" && workflow && dirtyRef.current) {
      setExiting(true);
      exitingRef.current = true;
      try {
        // Cap the wait so a stuck PATCH never traps the user on the page.
        await Promise.race([
          persist({ silent: true }),
          new Promise((r) => setTimeout(r, 4000)),
        ]);
      } catch {
        // Navigating away regardless — a failed flush is no worse than today.
      }
    }
    router.push("/workflows");
  }

  function handleSave(e?: React.FormEvent) {
    e?.preventDefault();
    startTransition(async () => {
      explicitPersistRef.current = true;
      try {
        await persist();
      } finally {
        explicitPersistRef.current = false;
      }
    });
  }

  // Single Draft ↔ Live control. `published` is the only gate — Live = the
  // dispatcher runs it; Draft = it doesn't (still editable + test-runnable).
  // Going Live saves the canvas then publishes; going Draft just unpublishes.
  // The /publish endpoint runs the stricter publish-tier validation.
  async function handleLiveToggle() {
    setTopErrors([]);
    // Publish is only meaningful on a saved row. Skip in create mode (the
    // control is disabled there anyway).
    if (mode !== "edit" || !workflow) return;
    const goLive = !published;
    if (goLive) {
      // Save the latest canvas first so /publish validates what's on screen.
      // Guard against the debounce aborting this save mid-flight.
      explicitPersistRef.current = true;
      let ok: boolean;
      try {
        ok = await persist({ silent: true });
      } finally {
        explicitPersistRef.current = false;
      }
      if (!ok) return;
    }
    const res = await apiFetch(`/api/team/workflows/${workflow.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publish: goLive }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: string;
      details?: string[];
      stepErrors?: Record<string, string>;
    };
    if (!res.ok) {
      setTopErrors(json.details ?? [json.error ?? `error ${res.status}`]);
      if (json.stepErrors) setStepErrors(json.stepErrors);
      return;
    }
    setPublished(goLive);
    // A successful publish means the graph validated clean — clear any stale
    // mid-build warnings. (Going Draft never validates, but clearing is still
    // correct: the unpublished workflow's warnings re-surface on the next save.)
    if (goLive) setWarnings([]);
    softRefresh();
  }

  async function handleTest() {
    if (!workflow) return;
    setTestError(null);
    setTestRunId(null);
    // Persist the on-screen canvas first so /test runs what the author sees,
    // not the last auto-saved snapshot (debounced ~1.5s behind). Guard against
    // the debounce aborting this save mid-flight (which would drop the test).
    explicitPersistRef.current = true;
    let saved: boolean;
    try {
      saved = await persist({ silent: true });
    } finally {
      explicitPersistRef.current = false;
    }
    if (!saved) return;
    const res = await apiFetch(`/api/team/workflows/${workflow.id}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const json = (await res.json()) as { runId: string };
      // Open the result drawer; it polls GET :id/runs/:runId to completion.
      setSelectedStepId(null);
      setTriggerOpen(false);
      setTestRunId(json.runId);
    } else {
      const txt = await res.text();
      setTestError(`Couldn't start test run: ${txt || res.status}`);
    }
  }

  async function handleDelete() {
    if (!workflow) return;
    const ok = await confirm({
      title: "Delete this workflow?",
      description: "The workflow and its run history will be removed. This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await apiFetch(`/api/team/workflows/${workflow.id}`, { method: "DELETE" });
    if (res.ok) router.push("/workflows");
    else setTopErrors([`delete failed: ${res.status}`]);
  }

  function updateSelectedConfig(config: Record<string, unknown>) {
    if (!selectedStepId) return;
    setGraph({
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === selectedStepId ? { ...n, config } : n,
      ),
    });
  }

  // ask_question option edits that also touch graph.edges — applied to ONE
  // graph snapshot so the config change and the edge reconciliation can't race
  // on a stale closure. `next` is the already-computed config; the edge op
  // re-labels (rename) or drops (remove) the matching per-option edge so a
  // renamed/removed option never orphans its wired child subtree (M7).
  function updateSelectedConfigWithEdges(
    config: Record<string, unknown>,
    edgeOp: AskOptionEdgeOp,
  ) {
    if (!selectedStepId) return;
    const withConfig: WorkflowGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === selectedStepId ? { ...n, config } : n,
      ),
    };
    const next =
      edgeOp.kind === "rename"
        ? renameOptionEdge(withConfig, selectedStepId, edgeOp.oldId, edgeOp.newId)
        : edgeOp.kind === "remove_all_options"
          ? // Leaving buttons/list for a kind with no per-option handles —
            // strip EVERY per-option edge so a published graph can't dead-end
            // a free-text reply at a stranded opt_N edge (audit fix F4).
            removeAllOptionEdges(withConfig, selectedStepId)
          : removeOptionEdge(withConfig, selectedStepId, edgeOp.optionId);
    setGraph(next);
  }

  /** Author-facing rename. Empty / whitespace-only input drops the field
   *  so the canvas falls back to "Step <id>". Trimmed + 80-char cap to
   *  match the server-side parser. */
  function updateSelectedName(name: string) {
    if (!selectedStepId) return;
    const trimmed = name.trim().slice(0, 80);
    setGraph({
      ...graph,
      nodes: graph.nodes.map((n) => {
        if (n.id !== selectedStepId) return n;
        if (trimmed.length === 0) {
          // Drop the field so the optional shape stays clean.
          const { name: _drop, ...rest } = n;
          return rest;
        }
        return { ...n, name: trimmed };
      }),
    });
  }

  // Shared confirm for step deletion. Covers BOTH the canvas trash button and
  // the Delete/Backspace key path (both route through handleDeleteStep), plus
  // the palette deleteSelected — a step + its config can't be recovered.
  async function confirmStepDelete(id: string): Promise<boolean> {
    const node = graph.nodes.find((n) => n.id === id);
    const label = node?.name?.trim() ? `“${node.name.trim()}”` : "this step";
    // Warn when removing this node would orphan reachable downstream steps —
    // a multi-output (branch/ask) node delete, or a start-node delete that
    // abandons sibling branches. removeStep only splices a single-output node,
    // so without this the subtree silently disappears.
    const disconnected = countDisconnectedByRemoval(graph, id);
    const base = "This removes the step from the workflow. This can't be undone.";
    const description =
      disconnected > 0
        ? `${base} It will also disconnect ${disconnected} downstream step${disconnected === 1 ? "" : "s"} from the workflow — you'll need to rewire ${disconnected === 1 ? "it" : "them"}.`
        : base;
    return confirm({
      title: `Delete ${label}?`,
      description,
      confirmLabel: "Delete",
      destructive: true,
    });
  }

  async function deleteSelected() {
    if (!selectedStepId) return;
    if (!(await confirmStepDelete(selectedStepId))) return;
    setGraph(removeStep(graph, selectedStepId));
    setSelectedStepId(null);
  }

  function handleInsertStep(
    sourceId: string | null,
    sourceHandle: string | null,
    type: StepType,
    positionOverride?: { x: number; y: number },
  ) {
    const { graph: next, newNodeId } = insertStepAfter(
      graph,
      sourceId,
      sourceHandle,
      type,
      positionOverride,
    );
    setGraph(next);
    // Auto-select so the editor drawer opens for the new step — same UX as
    // the left-palette add.
    setSelectedStepId(newNodeId);
    setTriggerOpen(false);
  }

  function handleDuplicateStep(id: string) {
    const { graph: next, newNodeId } = duplicateStep(graph, id);
    setGraph(next);
    setSelectedStepId(newNodeId);
    setTriggerOpen(false);
  }

  async function handleDeleteStep(id: string) {
    if (!(await confirmStepDelete(id))) return;
    setGraph(removeStep(graph, id));
    if (selectedStepId === id) setSelectedStepId(null);
  }

  const selectedNode = graph.nodes.find((n) => n.id === selectedStepId) ?? null;
  const triggerMeta = TRIGGER_OPTIONS.find((t) => t.value === trigger);
  // Live = the dispatcher runs it (published). Draft otherwise.
  const isLive = published;

  return (
    <form className="flex h-[calc(100svh-3rem)] flex-col md:h-svh" onSubmit={handleSave}>
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 md:gap-3 md:px-4">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 md:gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 max-w-md text-sm"
            placeholder="Workflow name"
          />
          <button
            type="button"
            onClick={handleLiveToggle}
            disabled={mode !== "edit"}
            title={
              isLive
                ? "Running on live triggers — click to switch back to a draft"
                : "Draft (not running) — click to validate and go live"
            }
            className={
              "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors disabled:opacity-50 " +
              (isLive
                ? "border-success-border bg-success-bg text-success-fg"
                : "border-border bg-muted text-muted-foreground")
            }
          >
            <Power className="size-3.5" />
            {isLive ? "Live" : "Draft"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {mode === "edit" && (
            <Button type="button" variant="outline" size="sm" onClick={handleTest}>
              <PlayCircle className="size-4" />
              Test
            </Button>
          )}
          <Button type="submit" size="sm" disabled={pending}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            {mode === "create" ? "Create" : "Save"}
          </Button>
          {mode === "edit" && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={handleDelete}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleExit}
            disabled={exiting}
          >
            {exiting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowUpRight className="size-4" />
            )}
            Exit
          </Button>
        </div>
      </div>

      {topErrors.length > 0 && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          <ul className="ml-4 list-disc">
            {topErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {testError && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {testError}
        </div>
      )}

      {/* Non-blocking — mid-build incompleteness (unwired Branch / ask_question
          outputs). The save succeeded; this just flags what's left to wire
          before the workflow can go Live. Styled amber, not destructive. */}
      {warnings.length > 0 && (
        <div className="border-b border-warning-border bg-warning-bg/40 px-4 py-2 text-xs text-warning-fg">
          <ul className="ml-4 list-disc">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Main: canvas + (optional) drawer. Steps are added inline via the
          "+" buttons on edges + the trailing "+" below leaf nodes, so the
          old left palette is gone. */}
      <div className="flex flex-1 overflow-hidden">
        {/* min-w-0 lets the canvas shrink (instead of overflowing) when a
            shrink-0 editor drawer is open on a narrow viewport. */}
        <div className="min-w-0 flex-1">
          <WorkflowCanvas
            graph={graph}
            selectedStepId={selectedStepId}
            triggerSelected={triggerOpen}
            triggerLabel={triggerMeta?.label ?? "Pick a trigger"}
            triggerDescription={triggerMeta?.description ?? ""}
            triggerType={trigger}
            onChange={setGraph}
            onSelectStep={(id) => {
              setSelectedStepId(id);
              if (id) setTriggerOpen(false);
            }}
            onSelectTrigger={() => {
              setTriggerOpen(true);
              setSelectedStepId(null);
            }}
            onInsertStep={handleInsertStep}
            onDuplicateStep={handleDuplicateStep}
            onDeleteStep={handleDeleteStep}
          />
        </div>

        {triggerOpen && (
          <TriggerEditorDrawer
            trigger={trigger}
            triggerConfig={triggerConfig}
            triggerConditions={triggerConditions}
            triggerOncePerContact={triggerOncePerContact}
            catalogs={catalogs}
            onChangeTrigger={setTrigger}
            onChangeConfig={setTriggerConfig}
            onChangeConditions={setTriggerConditions}
            onChangeOnce={setTriggerOncePerContact}
            onClose={() => setTriggerOpen(false)}
          />
        )}

        {selectedNode && (
          <StepEditorDrawer
            node={selectedNode}
            catalogs={catalogs}
            graph={graph}
            trigger={trigger}
            error={stepErrors[selectedNode.id]}
            onChangeConfig={updateSelectedConfig}
            onChangeConfigWithEdges={updateSelectedConfigWithEdges}
            onChangeName={updateSelectedName}
            onDelete={deleteSelected}
            onClose={() => setSelectedStepId(null)}
          />
        )}

        {/* Test-run result. Opens after Test; mutually exclusive with the
            editor drawers (handleTest clears both). Selecting a node /
            trigger doesn't auto-close it — the author closes it via the X. */}
        {testRunId && workflow && !selectedNode && !triggerOpen && (
          <TestRunDrawer
            workflowId={workflow.id}
            runId={testRunId}
            graph={graph}
            onClose={() => setTestRunId(null)}
          />
        )}
      </div>

      {confirmDialog}
    </form>
  );
}
