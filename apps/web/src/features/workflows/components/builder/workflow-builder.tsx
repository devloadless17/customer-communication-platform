"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
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

import { StepEditorDrawer } from "./step-editor-drawer";
import { TriggerEditorDrawer } from "./trigger-editor-drawer";
import {
  duplicateStep,
  insertStepAfter,
  removeStep,
  WorkflowCanvas,
} from "./workflow-canvas";
import {
  type BuilderCatalogs,
  type ConditionGroup,
  type StepType,
  type Trigger,
  type WorkflowGraph,
  TRIGGER_OPTIONS,
  toGroup,
} from "./types";

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
    toGroup(workflow?.triggerConditions),
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
  const [pending, startTransition] = useTransition();
  const [testStatus, setTestStatus] = useState<string | null>(null);

  // In-flight save AbortController. Aborted on unmount + before each
  // fresh save so a slow PATCH from a few keystrokes ago can't land
  // setState into an unmounted (or navigated-away) component, and a
  // freshly-typed change supersedes the prior save without two replies
  // racing into setTopErrors / setStepErrors.
  const persistCtlRef = useRef<AbortController | null>(null);

  // Auto-save in edit mode. Cheap (~one PATCH per couple seconds of
  // idle); the alternative — manual save button only — leads to "I lost
  // my changes" frustration when the tab crashes. We skip the auto-save
  // in create mode since there's no row to PATCH yet.
  useEffect(() => {
    if (mode !== "edit" || !workflow) return;
    const handle = setTimeout(() => {
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

  async function persist(opts: { silent?: boolean } = {}): Promise<boolean> {
    // Supersede any in-flight save — freshest input wins, prior
    // response is ignored on its way back.
    persistCtlRef.current?.abort();
    const ctl = new AbortController();
    persistCtlRef.current = ctl;

    const body = {
      name,
      trigger,
      triggerConfig,
      triggerConditions,
      triggerOncePerContact,
      graph,
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
    };
    if (ctl.signal.aborted) return false;
    if (!res.ok) {
      setTopErrors(json.details ?? [json.error ?? `error ${res.status}`]);
      if (json.stepErrors) setStepErrors(json.stepErrors);
      return false;
    }
    setTopErrors([]);
    setStepErrors({});
    if (mode === "create" && json.id) {
      router.push(`/workflows/${json.id}`);
    } else if (!opts.silent) {
      softRefresh();
    }
    return true;
  }

  function handleSave(e?: React.FormEvent) {
    e?.preventDefault();
    startTransition(async () => {
      await persist();
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
      const ok = await persist({ silent: true });
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
    softRefresh();
  }

  async function handleTest() {
    if (!workflow) return;
    setTestStatus("Running…");
    const res = await apiFetch(`/api/team/workflows/${workflow.id}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (res.ok) {
      const json = (await res.json()) as { runId: string };
      setTestStatus(`Test enqueued — runId ${json.runId}. Refresh runs in a couple of seconds.`);
    } else {
      const txt = await res.text();
      setTestStatus(`Failed: ${txt}`);
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

  function deleteSelected() {
    if (!selectedStepId) return;
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

  function handleDeleteStep(id: string) {
    setGraph(removeStep(graph, id));
    if (selectedStepId === id) setSelectedStepId(null);
  }

  const selectedNode = graph.nodes.find((n) => n.id === selectedStepId) ?? null;
  const triggerMeta = TRIGGER_OPTIONS.find((t) => t.value === trigger);
  // Live = the dispatcher runs it (published). Draft otherwise.
  const isLive = published;

  return (
    <form className="flex h-svh flex-col" onSubmit={handleSave}>
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
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
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
          <Button asChild variant="ghost" size="sm" type="button">
            <Link href="/workflows">
              <ArrowUpRight className="size-4" />
              Exit
            </Link>
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

      {testStatus && (
        <div className="border-b border-border bg-muted/40 px-4 py-2 text-xs">{testStatus}</div>
      )}

      {/* Main: canvas + (optional) drawer. Steps are added inline via the
          "+" buttons on edges + the trailing "+" below leaf nodes, so the
          old left palette is gone. */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1">
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
            onChangeName={updateSelectedName}
            onDelete={deleteSelected}
            onClose={() => setSelectedStepId(null)}
          />
        )}
      </div>

      {confirmDialog}
    </form>
  );
}
