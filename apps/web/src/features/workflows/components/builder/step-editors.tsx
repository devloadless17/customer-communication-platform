"use client";

import { Tag as TagIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { ConditionGroupEditor } from "./condition-group";
import { type BuilderCatalogs, type WorkflowGraph, toGroup } from "./types";

/**
 * Per-step editors. Each editor takes the (typed) config + onChange + the
 * subset of catalogs it needs. Kept in one file because most are small
 * (10-50 lines) and the import noise of one-file-per-editor was outweighing
 * its readability.
 */

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

// send_message --------------------------------------------------------------

export function SendMessageEditor({
  config,
  onChange,
}: {
  config: { body?: string };
  onChange: (c: Record<string, unknown>) => void;
}) {
  return (
    <Field
      label="Message"
      hint="Free-form text. Tokens like $var.contact.name resolve per contact. Outside the 24h window this step fails — use Send Template instead."
    >
      <Textarea
        value={config.body ?? ""}
        onChange={(e) => onChange({ body: e.target.value })}
        rows={4}
        placeholder="Hi $var.contact.name, thanks for reaching out!"
      />
    </Field>
  );
}

// send_template -------------------------------------------------------------

function countPlaceholders(text: string): number {
  const found = new Set<number>();
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.add(Number.parseInt(m[1]!, 10));
  return found.size;
}

export function SendTemplateEditor({
  config,
  onChange,
  templates,
}: {
  config: { templateId?: string; variables?: { body?: string[]; header?: string } };
  onChange: (c: Record<string, unknown>) => void;
  templates: BuilderCatalogs["templates"];
}) {
  const approved = templates.filter((t) => t.status === "approved");
  const selected = templates.find((t) => t.id === config.templateId);
  const bodyVarCount = selected ? countPlaceholders(selected.bodyText) : 0;
  const bodyVars = config.variables?.body ?? [];

  function pickTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (!t) {
      onChange({ templateId: id, variables: { body: [] } });
      return;
    }
    const count = countPlaceholders(t.bodyText);
    const next = Array.from({ length: count }, (_, i) => bodyVars[i] ?? "");
    onChange({ templateId: id, variables: { body: next } });
  }

  function setVar(idx: number, val: string) {
    const next = bodyVars.slice();
    while (next.length <= idx) next.push("");
    next[idx] = val;
    onChange({ ...config, variables: { ...config.variables, body: next } });
  }

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Template"
        hint={
          approved.length === 0
            ? "No approved templates yet — submit one in Templates → New first."
            : "Only approved templates can be sent."
        }
      >
        <select
          value={config.templateId ?? ""}
          onChange={(e) => pickTemplate(e.target.value)}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Select a template…</option>
          {approved.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.language})
            </option>
          ))}
        </select>
      </Field>
      {selected && (
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Preview</div>
          <pre className="mt-1 whitespace-pre-wrap font-sans text-sm">{selected.bodyText}</pre>
        </div>
      )}
      {bodyVarCount > 0 && (
        <Field label={`Variables (${bodyVarCount})`} hint="Tokens like $var.contact.name resolve per run.">
          <div className="flex flex-col gap-2">
            {Array.from({ length: bodyVarCount }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">{`{{${i + 1}}}`}</span>
                <Input value={bodyVars[i] ?? ""} onChange={(e) => setVar(i, e.target.value)} />
              </div>
            ))}
          </div>
        </Field>
      )}
    </div>
  );
}

// add_comment --------------------------------------------------------------

export function AddCommentEditor({
  config,
  onChange,
}: {
  config: { body?: string };
  onChange: (c: Record<string, unknown>) => void;
}) {
  return (
    <Field
      label="Note"
      hint="Internal — never sent to the contact. Tokens like $var.contact.name resolve per run."
    >
      <Textarea
        value={config.body ?? ""}
        onChange={(e) => onChange({ body: e.target.value })}
        rows={3}
        placeholder="Customer asking for $var.contact.email — needs invoice"
      />
    </Field>
  );
}

// assign_to ----------------------------------------------------------------

export function AssignToEditor({
  config,
  onChange,
  users,
}: {
  config: { mode?: "user" | "unassign"; userId?: string };
  onChange: (c: Record<string, unknown>) => void;
  users: BuilderCatalogs["users"];
}) {
  return (
    <Field label="Mode">
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="assign-mode"
            checked={config.mode === "user"}
            onChange={() => onChange({ mode: "user", userId: config.userId ?? users[0]?.id ?? "" })}
          />
          Assign to a teammate
        </label>
        {config.mode === "user" && (
          <select
            value={config.userId ?? ""}
            onChange={(e) => onChange({ mode: "user", userId: e.target.value })}
            className="ml-6 h-8 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">Select a user…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="assign-mode"
            checked={config.mode === "unassign"}
            onChange={() => onChange({ mode: "unassign" })}
          />
          Unassign
        </label>
      </div>
    </Field>
  );
}

// set_status / open_conversation / close_conversation ----------------------

export function SetStatusEditor({
  config,
  onChange,
}: {
  config: { status?: "open" | "pending" | "closed" };
  onChange: (c: Record<string, unknown>) => void;
}) {
  return (
    <Field label="Target status">
      <select
        value={config.status ?? "open"}
        onChange={(e) => onChange({ status: e.target.value })}
        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
      >
        <option value="open">Open</option>
        <option value="pending">Pending</option>
        <option value="closed">Closed</option>
      </select>
    </Field>
  );
}

export function OpenConversationEditor() {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      Opens the conversation. No further configuration.
    </div>
  );
}

export function CloseConversationEditor({
  config,
  onChange,
}: {
  config: { category?: string; summary?: string };
  onChange: (c: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Category" hint="Optional. Shown in the inbox close-history.">
        <Input
          value={config.category ?? ""}
          onChange={(e) => onChange({ ...config, category: e.target.value })}
          placeholder="resolved / abandoned / spam"
        />
      </Field>
      <Field label="Summary" hint="Optional. Free-form note about what happened.">
        <Textarea
          value={config.summary ?? ""}
          onChange={(e) => onChange({ ...config, summary: e.target.value })}
          rows={3}
        />
      </Field>
    </div>
  );
}

// add_tag / remove_tag ------------------------------------------------------

export function TagEditor({
  config,
  onChange,
  tags,
  verb,
}: {
  config: { tagId?: string };
  onChange: (c: Record<string, unknown>) => void;
  tags: BuilderCatalogs["tags"];
  verb: "Add" | "Remove";
}) {
  const selected = tags.find((t) => t.id === config.tagId);
  return (
    <Field
      label="Tag"
      hint={tags.length === 0 ? "No tags yet — create them in Settings → Tags." : `${verb} this tag from the contact.`}
    >
      <div className="flex flex-col gap-2">
        <select
          value={config.tagId ?? ""}
          onChange={(e) => onChange({ tagId: e.target.value })}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Select a tag…</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {selected && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TagIcon className="size-3.5" />
            <span className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">
              {selected.name}
            </span>
          </div>
        )}
      </div>
    </Field>
  );
}

// update_field --------------------------------------------------------------

export function UpdateFieldEditor({
  config,
  onChange,
  fields,
}: {
  config: { fieldKey?: string; value?: string };
  onChange: (c: Record<string, unknown>) => void;
  fields: BuilderCatalogs["fields"];
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Field" hint="The contact's custom fields. Add new ones in Settings → Contact Fields.">
        <select
          value={config.fieldKey ?? ""}
          onChange={(e) => onChange({ ...config, fieldKey: e.target.value })}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Select a field…</option>
          {fields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label} ({f.key})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Value" hint="Tokens like $var.contact.email resolve per run.">
        <Input
          value={config.value ?? ""}
          onChange={(e) => onChange({ ...config, value: e.target.value })}
        />
      </Field>
    </div>
  );
}

// update_lifecycle ----------------------------------------------------------

export function UpdateLifecycleEditor({
  config,
  onChange,
  stages,
}: {
  config: { stageId?: string };
  onChange: (c: Record<string, unknown>) => void;
  stages: BuilderCatalogs["stages"];
}) {
  return (
    <Field label="Stage">
      <select
        value={config.stageId ?? ""}
        onChange={(e) => onChange({ stageId: e.target.value })}
        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
      >
        <option value="">Select a stage…</option>
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

// branch --------------------------------------------------------------------

export function BranchEditor({
  config,
  onChange,
}: {
  config: { conditions?: unknown };
  onChange: (c: Record<string, unknown>) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs text-muted-foreground">
        Step routes to the <strong>true</strong> branch when conditions match,
        otherwise to <strong>false</strong>. Connect both edges in the canvas.
      </div>
      <ConditionGroupEditor
        trigger="message_received"
        group={toGroup(config.conditions)}
        onChange={(g) => onChange({ conditions: g })}
        allowAllFields
      />
    </div>
  );
}

// wait ----------------------------------------------------------------------

export function WaitEditor({
  config,
  onChange,
}: {
  config: { delayMs?: number };
  onChange: (c: Record<string, unknown>) => void;
}) {
  const ms = config.delayMs ?? 60_000;
  // Pick a sensible default unit based on size of the current value.
  const initialUnit: "s" | "m" | "h" | "d" =
    ms >= 86_400_000 ? "d" : ms >= 3_600_000 ? "h" : ms >= 60_000 ? "m" : "s";

  const multipliers: Record<typeof initialUnit, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  const value = Math.round(ms / multipliers[initialUnit]);

  return (
    <Field label="Duration" hint="The run pauses here. Resume is scheduled via BullMQ.">
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          value={value}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n > 0) {
              onChange({ delayMs: n * multipliers[initialUnit] });
            }
          }}
          className="max-w-[120px]"
        />
        <select
          value={initialUnit}
          onChange={(e) => {
            const unit = e.target.value as typeof initialUnit;
            onChange({ delayMs: value * multipliers[unit] });
          }}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="s">seconds</option>
          <option value="m">minutes</option>
          <option value="h">hours</option>
          <option value="d">days</option>
        </select>
      </div>
    </Field>
  );
}

// jump_to_step --------------------------------------------------------------

export function JumpToStepEditor({
  config,
  onChange,
  graph,
  selfId,
}: {
  config: { targetStepId?: string; maxJumps?: number };
  onChange: (c: Record<string, unknown>) => void;
  graph: WorkflowGraph;
  selfId: string;
}) {
  const otherNodes = graph.nodes.filter((n) => n.id !== selfId);
  return (
    <div className="flex flex-col gap-4">
      <Field label="Target step">
        <select
          value={config.targetStepId ?? ""}
          onChange={(e) => onChange({ ...config, targetStepId: e.target.value })}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Select a step…</option>
          {otherNodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.id} ({n.type})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Max jumps (optional)" hint="Per-run cap. The global ceiling is 100 steps regardless.">
        <Input
          type="number"
          min={1}
          value={config.maxJumps ?? ""}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            onChange({
              ...config,
              maxJumps: Number.isFinite(n) && n > 0 ? n : undefined,
            });
          }}
          className="max-w-[120px]"
        />
      </Field>
    </div>
  );
}

// http_request --------------------------------------------------------------

export function HttpRequestEditor({
  config,
  onChange,
}: {
  config: {
    url?: string;
    bearerToken?: string;
    bearerTokenSet?: boolean;
    customHeaders?: Record<string, string>;
    timeoutMs?: number;
  };
  onChange: (c: Record<string, unknown>) => void;
}) {
  const tokenSet = config.bearerTokenSet === true;

  function headersToText(h?: Record<string, string>): string {
    if (!h) return "";
    return Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n");
  }

  function parseHeaders(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(":");
      if (idx === -1) continue;
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="URL" hint="HTTPS preferred. $var.contact.* tokens resolve per run.">
        <Input
          value={config.url ?? ""}
          onChange={(e) => onChange({ ...config, url: e.target.value })}
          placeholder="https://api.example.com/webhook"
          required
        />
      </Field>
      <Field
        label="Bearer token (optional)"
        hint={tokenSet ? "Token saved. Leave blank to keep, or enter a new value to overwrite." : ""}
      >
        <Input
          type="password"
          value={config.bearerToken ?? ""}
          onChange={(e) => onChange({ ...config, bearerToken: e.target.value })}
          placeholder={tokenSet ? "•••••••• (saved)" : ""}
        />
      </Field>
      <Field label="Custom headers (optional)" hint="One per line: Header-Name: value">
        <Textarea
          value={headersToText(config.customHeaders)}
          onChange={(e) => {
            const parsed = parseHeaders(e.target.value);
            onChange({
              ...config,
              customHeaders: Object.keys(parsed).length > 0 ? parsed : undefined,
            });
          }}
          rows={3}
        />
      </Field>
      <Field label="Timeout (ms, optional, max 60000)">
        <Input
          type="number"
          value={config.timeoutMs?.toString() ?? ""}
          onChange={(e) => {
            const n = Number.parseInt(e.target.value, 10);
            onChange({
              ...config,
              timeoutMs: Number.isFinite(n) && n > 0 ? n : undefined,
            });
          }}
          placeholder="8000"
          min={1}
          max={60_000}
        />
      </Field>
    </div>
  );
}

// trigger_workflow ----------------------------------------------------------

export function TriggerWorkflowEditor({
  config,
  onChange,
  workflows,
}: {
  config: { workflowId?: string };
  onChange: (c: Record<string, unknown>) => void;
  workflows: BuilderCatalogs["workflows"];
}) {
  const eligible = workflows.filter((w) => w.trigger === "manual_trigger");
  return (
    <Field
      label="Workflow"
      hint={
        eligible.length === 0
          ? "No manual_trigger workflows yet — create one first."
          : "Only workflows with trigger = manual_trigger can be invoked from another workflow."
      }
    >
      <select
        value={config.workflowId ?? ""}
        onChange={(e) => onChange({ workflowId: e.target.value })}
        className="h-9 rounded-md border border-border bg-background px-2 text-sm"
      >
        <option value="">Select a workflow…</option>
        {eligible.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
