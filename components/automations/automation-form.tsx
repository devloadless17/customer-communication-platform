"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, PlayCircle, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm-dialog";

import {
  ConditionBuilder,
  type ConditionRow,
} from "@/components/automations/condition-builder";

/**
 * Create/edit form for an Automation. Single component, two modes:
 *
 *   mode="create" → POST /api/team/automations → redirect to detail page
 *   mode="edit"   → PATCH /api/team/automations/[id] → router.refresh()
 *
 * The "Test" button only appears in edit mode (we need a saved automationId
 * to enqueue a job).
 */

type Trigger = "message_received" | "conversation_assigned" | "conversation_status_changed";

interface ActionConfigInitial {
  url: string;
  bearerTokenSet: boolean;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
}

interface AutomationInitial {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  conditions: unknown[];
  actionConfig: ActionConfigInitial;
}

interface Props {
  mode: "create" | "edit";
  automation?: AutomationInitial;
}

const TRIGGER_OPTIONS: Array<{ value: Trigger; label: string; description: string }> = [
  {
    value: "message_received",
    label: "Message received",
    description: "Fires every time an inbound WhatsApp message arrives. Add a body filter to scope to keywords.",
  },
  {
    value: "conversation_assigned",
    label: "Conversation assigned",
    description: "Fires when a conversation is assigned (or reassigned) to an agent.",
  },
  {
    value: "conversation_status_changed",
    label: "Status changed",
    description: "Fires when a conversation moves between open / pending / closed.",
  },
];

export function AutomationForm({ mode, automation }: Props) {
  const router = useRouter();
  const [name, setName] = useState(automation?.name ?? "");
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  const [trigger, setTrigger] = useState<Trigger>(automation?.trigger ?? "message_received");
  const [conditions, setConditions] = useState<ConditionRow[]>(() =>
    (automation?.conditions ?? []).map(toConditionRow).filter(Boolean) as ConditionRow[],
  );
  const [url, setUrl] = useState(automation?.actionConfig.url ?? "");
  const [bearerToken, setBearerToken] = useState("");
  const [headersText, setHeadersText] = useState(
    headersToText(automation?.actionConfig.customHeaders),
  );
  const [timeoutMs, setTimeoutMs] = useState(
    automation?.actionConfig.timeoutMs?.toString() ?? "",
  );
  const tokenSet = automation?.actionConfig.bearerTokenSet ?? false;

  const [errors, setErrors] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const [testResult, setTestResult] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrors([]);
    setTestResult(null);

    let customHeaders: Record<string, string> | undefined;
    try {
      customHeaders = parseHeaders(headersText);
    } catch (err) {
      setErrors([`custom headers: ${err instanceof Error ? err.message : "invalid"}`]);
      return;
    }

    const timeoutN = timeoutMs.trim() ? Number.parseInt(timeoutMs.trim(), 10) : undefined;
    const actionConfig: Record<string, unknown> = { url };
    // Leaving the bearer token blank when one is already set tells the API
    // to keep the existing value. New value overwrites.
    if (bearerToken) actionConfig.bearerToken = bearerToken;
    if (customHeaders && Object.keys(customHeaders).length > 0) {
      actionConfig.customHeaders = customHeaders;
    }
    if (timeoutN && Number.isFinite(timeoutN) && timeoutN > 0) {
      actionConfig.timeoutMs = timeoutN;
    }

    const body = {
      name,
      enabled,
      trigger,
      conditions,
      actionType: "webhook",
      actionConfig,
    };

    startTransition(async () => {
      const path =
        mode === "create"
          ? "/api/team/automations"
          : `/api/team/automations/${automation!.id}`;
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
      };
      if (!res.ok) {
        setErrors(json.details ?? [json.error ?? `error ${res.status}`]);
        return;
      }
      if (mode === "create" && json.id) {
        router.push(`/automations/${json.id}`);
      } else {
        router.refresh();
      }
    });
  }

  async function handleTest() {
    if (!automation) return;
    setTestResult("Sending test…");
    const res = await fetch(`/api/team/automations/${automation.id}/test`, {
      method: "POST",
    });
    if (res.ok) {
      setTestResult("Test enqueued — refresh the runs table in a couple of seconds.");
    } else {
      const txt = await res.text();
      setTestResult(`Failed: ${txt}`);
    }
  }

  async function handleDelete() {
    if (!automation) return;
    const ok = await confirm({
      title: "Delete this automation?",
      description: "The rule and its run history will be removed. This can't be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/team/automations/${automation.id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      router.push("/automations");
    } else {
      setErrors([`delete failed: ${res.status}`]);
    }
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit}>
      {/* Name + enabled */}
      <Field label="Name" hint="Internal — only your team sees it.">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Forward inbound to AI agent"
          maxLength={100}
          required
        />
      </Field>

      {/* Trigger */}
      <Field label="Trigger" hint="What event runs this automation.">
        <div className="flex flex-col gap-2">
          {TRIGGER_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className={
                "cursor-pointer rounded-md border px-3 py-2.5 text-sm transition-colors " +
                (trigger === opt.value
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-accent/40")
              }
            >
              <div className="flex items-start gap-2.5">
                <input
                  type="radio"
                  className="mt-0.5"
                  name="trigger"
                  value={opt.value}
                  checked={trigger === opt.value}
                  onChange={() => {
                    setTrigger(opt.value);
                    // Reset conditions when trigger changes — different
                    // triggers expose different condition fields.
                    setConditions([]);
                  }}
                />
                <div>
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-xs text-muted-foreground">{opt.description}</div>
                </div>
              </div>
            </label>
          ))}
        </div>
      </Field>

      {/* Conditions */}
      <Field
        label="Conditions"
        hint="All conditions must match. Leave empty to fire on every event."
      >
        <ConditionBuilder
          trigger={trigger}
          conditions={conditions}
          onChange={setConditions}
        />
      </Field>

      {/* Webhook config */}
      <fieldset className="flex flex-col gap-4 rounded-md border border-border p-4">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Webhook
        </legend>
        <Field
          label="URL"
          hint="HTTPS preferred. Contact tokens like $var.contact.email or $var.contact.<custom_field> are substituted per run."
        >
          <Input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://n8n.you.com/webhook/$var.contact.email"
            required
          />
        </Field>
        <Field
          label="Bearer token (optional)"
          hint={
            tokenSet
              ? "A token is already saved. Leave blank to keep, or enter a new value to overwrite. $var.contact.* tokens are resolved per run."
              : "Sent as `Authorization: Bearer …` if set. $var.contact.* tokens are resolved per run."
          }
        >
          <Input
            type="password"
            value={bearerToken}
            onChange={(e) => setBearerToken(e.target.value)}
            placeholder={tokenSet ? "•••••••• (saved)" : ""}
            autoComplete="off"
          />
        </Field>
        <Field
          label="Custom headers (optional)"
          hint="One per line, format: Header-Name: value. $var.contact.* tokens in values are substituted per run."
        >
          <Textarea
            value={headersText}
            onChange={(e) => setHeadersText(e.target.value)}
            placeholder="X-Contact-Id: $var.contact.phone"
            rows={3}
          />
        </Field>
        <Field label="Timeout (ms, optional, max 60000)">
          <Input
            type="number"
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(e.target.value)}
            placeholder="8000"
            min={1}
            max={60000}
          />
        </Field>
      </fieldset>

      {/* Enabled toggle */}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enabled
      </label>

      {/* Errors */}
      {errors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <div className="font-medium">Couldn't save:</div>
          <ul className="ml-4 mt-1 list-disc">
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {testResult && (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">{testResult}</div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          {mode === "create" ? "Create automation" : "Save changes"}
        </Button>
        <Button asChild variant="ghost" type="button">
          <Link href="/automations">Cancel</Link>
        </Button>
        {mode === "edit" && (
          <>
            <Button type="button" variant="outline" onClick={handleTest}>
              <PlayCircle className="size-4" />
              Test
            </Button>
            <div className="ml-auto">
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={handleDelete}
              >
                <Trash2 className="size-4" />
                Delete
              </Button>
            </div>
          </>
        )}
      </div>

      {confirmDialog}
    </form>
  );
}

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

function toConditionRow(raw: unknown): ConditionRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.field !== "string" || typeof r.op !== "string") return null;
  return {
    field: r.field as ConditionRow["field"],
    op: r.op as ConditionRow["op"],
    value: typeof r.value === "string" ? r.value : "",
  };
}

function headersToText(headers: Record<string, string> | undefined): string {
  if (!headers) return "";
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx === -1) {
      throw new Error(`missing ":" in line: ${trimmed}`);
    }
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim();
    if (!k) throw new Error(`empty header name in line: ${trimmed}`);
    out[k] = v;
  }
  return out;
}
