"use client";

import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  AddCommentEditor,
  AssignToEditor,
  BranchEditor,
  CloseConversationEditor,
  HttpRequestEditor,
  JumpToStepEditor,
  OpenConversationEditor,
  SendMessageEditor,
  SendTemplateEditor,
  SetStatusEditor,
  TagEditor,
  TriggerWorkflowEditor,
  UpdateFieldEditor,
  UpdateLifecycleEditor,
  WaitEditor,
} from "./step-editors";
import {
  type BuilderCatalogs,
  type Trigger,
  type WorkflowGraph,
  type WorkflowNode,
  STEP_OPTIONS,
} from "./types";

/**
 * Side-drawer editor for whichever canvas node is selected. Picks the right
 * per-step editor based on node.type and threads onChange back up. Closes
 * via X / Escape (handled by the parent passing a handler).
 *
 * Trigger node editor is handled separately in TriggerEditorDrawer because
 * the trigger card is conceptually distinct from steps.
 */

interface Props {
  node: WorkflowNode;
  catalogs: BuilderCatalogs;
  graph: WorkflowGraph;
  /** The workflow's trigger — used by BranchEditor to scope its
   *  condition fields. Without it the branch offers fields that
   *  only the lifecycle / status-changed triggers populate, which
   *  silently never match for a message_received workflow. */
  trigger: Trigger;
  error?: string;
  onChangeConfig: (config: Record<string, unknown>) => void;
  /** Persist the author-supplied node title. Empty input drops the field
   *  (canvas falls back to the step type label). */
  onChangeName: (name: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function StepEditorDrawer({
  node,
  catalogs,
  graph,
  trigger,
  error,
  onChangeConfig,
  onChangeName,
  onDelete,
  onClose,
}: Props) {
  const meta = STEP_OPTIONS.find((s) => s.value === node.type);

  return (
    <aside className="flex h-full w-96 flex-col border-l border-border bg-card">
      <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {meta?.label ?? node.type}
          </div>
          {/* Inline rename. Defaults to empty when the node has no name so
              the placeholder ("Step abc123") gives the author a hint of
              the fallback. Save on blur or Enter — both feel native and
              avoid setGraph on every keystroke. We DON'T render the
              node.id directly anymore; making it the placeholder keeps
              identification possible without locking the field. */}
          <Input
            value={node.name ?? ""}
            onChange={(e) => onChangeName(e.target.value)}
            placeholder={`Step ${node.id.slice(0, 6)}`}
            maxLength={80}
            className="mt-0.5 h-8 px-2 text-sm font-medium"
            aria-label="Rename step"
          />
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} className="size-8 shrink-0" aria-label="Close">
          <X className="size-4" />
        </Button>
      </header>

      {meta?.description && (
        <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          {meta.description}
        </div>
      )}

      {error && (
        <div className="mx-4 mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <EditorForNode
          node={node}
          catalogs={catalogs}
          graph={graph}
          trigger={trigger}
          onChangeConfig={onChangeConfig}
        />
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <Button
          type="button"
          variant="ghost"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
        >
          Delete step
        </Button>
      </footer>
    </aside>
  );
}

function EditorForNode({
  node,
  catalogs,
  graph,
  trigger,
  onChangeConfig,
}: {
  node: WorkflowNode;
  catalogs: BuilderCatalogs;
  graph: WorkflowGraph;
  trigger: Trigger;
  onChangeConfig: (config: Record<string, unknown>) => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = node.config as any;
  switch (node.type) {
    case "send_message":
      return <SendMessageEditor config={c} onChange={onChangeConfig} fields={catalogs.fields} trigger={trigger} />;
    case "send_template":
      return <SendTemplateEditor config={c} onChange={onChangeConfig} templates={catalogs.templates} fields={catalogs.fields} trigger={trigger} />;
    case "add_comment":
      return <AddCommentEditor config={c} onChange={onChangeConfig} fields={catalogs.fields} trigger={trigger} />;
    case "assign_to":
      return <AssignToEditor config={c} onChange={onChangeConfig} users={catalogs.users} />;
    case "set_status":
      return <SetStatusEditor config={c} onChange={onChangeConfig} />;
    case "open_conversation":
      return <OpenConversationEditor />;
    case "close_conversation":
      return <CloseConversationEditor config={c} onChange={onChangeConfig} />;
    case "add_tag":
      return <TagEditor config={c} onChange={onChangeConfig} tags={catalogs.tags} verb="Add" />;
    case "remove_tag":
      return <TagEditor config={c} onChange={onChangeConfig} tags={catalogs.tags} verb="Remove" />;
    case "update_field":
      return <UpdateFieldEditor config={c} onChange={onChangeConfig} fields={catalogs.fields} />;
    case "update_lifecycle":
      return <UpdateLifecycleEditor config={c} onChange={onChangeConfig} stages={catalogs.stages} />;
    case "branch":
      return <BranchEditor config={c} trigger={trigger} onChange={onChangeConfig} catalogs={catalogs} />;
    case "wait":
      return <WaitEditor config={c} onChange={onChangeConfig} />;
    case "jump_to_step":
      return <JumpToStepEditor config={c} onChange={onChangeConfig} graph={graph} selfId={node.id} />;
    case "http_request":
      return <HttpRequestEditor config={c} onChange={onChangeConfig} />;
    case "trigger_workflow":
      return <TriggerWorkflowEditor config={c} onChange={onChangeConfig} workflows={catalogs.workflows} />;
  }
}
