"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Loader2,
  PlayCircle,
  Plus,
  Power,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";

import { StepEditorDrawer } from "./step-editor-drawer";
import { StepPalette } from "./step-palette";
import { TriggerEditorDrawer } from "./trigger-editor-drawer";
import {
  appendStep,
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
 *   - Top bar carries name + enabled toggle + Save/Publish/Test buttons.
 */

interface InitialWorkflow {
  id: string;
  name: string;
  enabled: boolean;
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
  const { confirm, confirmDialog } = useConfirm();

  const [name, setName] = useState(workflow?.name ?? "Untitled workflow");
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);
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
  }, [name, enabled, trigger, triggerConfig, triggerConditions, triggerOncePerContact, graph]);

  async function persist(opts: { silent?: boolean } = {}): Promise<boolean> {
    const body = {
      name,
      enabled,
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
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      error?: string;
      details?: string[];
      stepErrors?: Record<string, string>;
    };
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
      router.refresh();
    }
    return true;
  }

  function handleSave(e?: React.FormEvent) {
    e?.preventDefault();
    startTransition(async () => {
      await persist();
    });
  }

  async function handlePublishToggle() {
    setTopErrors([]);
    // Save first so the publish endpoint validates against the latest
    // canvas. Skip when create mode — publish is only meaningful on a
    // saved row.
    if (mode !== "edit" || !workflow) return;
    const ok = await persist({ silent: true });
    if (!ok) return;

    const next = !published;
    const res = await fetch(`/api/team/workflows/${workflow.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publish: next }),
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
    setPublished(next);
    router.refresh();
  }

  async function handleTest() {
    if (!workflow) return;
    setTestStatus("Running…");
    const res = await fetch(`/api/team/workflows/${workflow.id}/test`, {
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
    const res = await fetch(`/api/team/workflows/${workflow.id}`, { method: "DELETE" });
    if (res.ok) router.push("/workflows");
    else setTopErrors([`delete failed: ${res.status}`]);
  }

  function addStep(type: StepType) {
    const next = appendStep(graph, type);
    setGraph(next);
    // Auto-select the new node so the editor drawer opens for it.
    const newNode = next.nodes[next.nodes.length - 1]!;
    setSelectedStepId(newNode.id);
    setTriggerOpen(false);
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

  function deleteSelected() {
    if (!selectedStepId) return;
    setGraph(removeStep(graph, selectedStepId));
    setSelectedStepId(null);
  }

  const selectedNode = graph.nodes.find((n) => n.id === selectedStepId) ?? null;
  const triggerMeta = TRIGGER_OPTIONS.find((t) => t.value === trigger);

  return (
    <form className="flex h-svh flex-col" onSubmit={handleSave}>
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 max-w-md text-sm"
            placeholder="Workflow name"
          />
          <button
            type="button"
            onClick={() => setEnabled((v) => !v)}
            className={
              "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors " +
              (enabled
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-border bg-muted text-muted-foreground")
            }
          >
            <Power className="size-3.5" />
            {enabled ? "Enabled" : "Disabled"}
          </button>
          <button
            type="button"
            onClick={handlePublishToggle}
            disabled={mode !== "edit"}
            className={
              "flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors disabled:opacity-50 " +
              (published
                ? "border-primary/60 bg-primary/10 text-primary"
                : "border-border bg-muted text-muted-foreground")
            }
          >
            {published ? "Published" : "Draft"}
          </button>
        </div>
        <div className="flex items-center gap-2">
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

      {/* Main: palette + canvas + (optional) drawer */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex w-60 shrink-0 flex-col gap-2 border-r border-border bg-card px-3 py-3">
          <div className="flex items-center gap-2 px-1">
            <Plus className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-medium">Add steps</span>
          </div>
          <StepPalette onPick={addStep} />
        </div>

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
            error={stepErrors[selectedNode.id]}
            onChangeConfig={updateSelectedConfig}
            onDelete={deleteSelected}
            onClose={() => setSelectedStepId(null)}
          />
        )}
      </div>

      {confirmDialog}
    </form>
  );
}
