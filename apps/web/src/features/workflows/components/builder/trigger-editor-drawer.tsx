"use client";

import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { ConditionGroupEditor } from "./condition-group";
import {
  type BuilderCatalogs,
  type ConditionGroup,
  type Trigger,
  TRIGGER_OPTIONS,
  toGroup,
} from "./types";

/**
 * Side-drawer for editing the workflow's trigger:
 *   - which event type fires it
 *   - trigger-specific config (secrets for incoming_webhook, etc.)
 *   - trigger conditions (filters the event before fanning out)
 *   - "Trigger once per contact" checkbox
 *
 * Separate from StepEditorDrawer because the trigger isn't a node in the
 * graph — it's a property of the Workflow row itself.
 */

interface Props {
  trigger: Trigger;
  triggerConfig: Record<string, unknown>;
  triggerConditions: unknown;
  triggerOncePerContact: boolean;
  catalogs: BuilderCatalogs;
  onChangeTrigger: (t: Trigger) => void;
  onChangeConfig: (cfg: Record<string, unknown>) => void;
  onChangeConditions: (c: ConditionGroup) => void;
  onChangeOnce: (v: boolean) => void;
  onClose: () => void;
}

const TRIGGER_GROUPS: Record<string, string> = {
  inbox: "Inbox events",
  contact: "Contact events",
  external: "External / on-demand",
};

export function TriggerEditorDrawer({
  trigger,
  triggerConfig,
  triggerConditions,
  triggerOncePerContact,
  catalogs,
  onChangeTrigger,
  onChangeConfig,
  onChangeConditions,
  onChangeOnce,
  onClose,
}: Props) {
  const grouped = TRIGGER_OPTIONS.reduce<Record<string, typeof TRIGGER_OPTIONS>>((acc, t) => {
    (acc[t.group] ??= []).push(t);
    return acc;
  }, {});

  return (
    <aside className="flex h-full w-96 flex-col border-l border-border bg-card">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Trigger
          </div>
          <div className="text-sm font-medium">When this fires</div>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={onClose} className="size-8" aria-label="Close">
          <X className="size-4" />
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-5">
          <div>
            <label className="mb-1.5 block text-sm font-medium">Trigger event</label>
            <div className="flex flex-col gap-3">
              {Object.entries(grouped).map(([group, options]) => (
                <div key={group}>
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {TRIGGER_GROUPS[group] ?? group}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {options.map((o) => (
                      <label
                        key={o.value}
                        className={
                          "cursor-pointer rounded-md border px-2.5 py-2 text-sm transition-colors " +
                          (trigger === o.value
                            ? "border-primary bg-primary/5"
                            : "border-border hover:bg-accent/40")
                        }
                      >
                        <div className="flex items-start gap-2">
                          <input
                            type="radio"
                            name="trigger"
                            className="mt-0.5"
                            checked={trigger === o.value}
                            onChange={() => {
                              onChangeTrigger(o.value);
                              // Reset conditions — different triggers expose
                              // different fields. Easier than scrubbing.
                              onChangeConditions({ op: "AND", children: [] });
                            }}
                          />
                          <div>
                            <div className="font-medium">{o.label}</div>
                            <div className="text-[11px] text-muted-foreground">{o.description}</div>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <TriggerConfigSection
            trigger={trigger}
            config={triggerConfig}
            onChange={onChangeConfig}
            catalogs={catalogs}
          />

          <div>
            <label className="mb-1.5 block text-sm font-medium">Conditions (optional)</label>
            <ConditionGroupEditor
              trigger={trigger}
              group={toGroup(triggerConditions)}
              onChange={onChangeConditions}
              catalogs={catalogs}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={triggerOncePerContact}
              onChange={(e) => onChangeOnce(e.target.checked)}
            />
            Trigger once per contact
          </label>
        </div>
      </div>
    </aside>
  );
}

function TriggerConfigSection({
  trigger,
  config,
  onChange,
  catalogs,
}: {
  trigger: Trigger;
  config: Record<string, unknown>;
  onChange: (cfg: Record<string, unknown>) => void;
  catalogs: BuilderCatalogs;
}) {
  if (trigger === "incoming_webhook") {
    return (
      <div>
        <label className="mb-1.5 block text-sm font-medium">Signing secret</label>
        <Input
          value={(config.secret as string) ?? ""}
          onChange={(e) => onChange({ ...config, secret: e.target.value })}
          placeholder="Random secret string"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Required. Used to HMAC-SHA256 sign the request body in the{" "}
          <code className="font-mono">X-Workflow-Signature</code> header.
        </p>
      </div>
    );
  }
  if (trigger === "contact_tag_updated") {
    return (
      <div>
        <label className="mb-1.5 block text-sm font-medium">Listen for</label>
        <select
          value={(config.kind as string) ?? "any"}
          onChange={(e) => onChange({ ...config, kind: e.target.value })}
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="any">Any change</option>
          <option value="added">Tag added</option>
          <option value="removed">Tag removed</option>
        </select>
      </div>
    );
  }
  if (trigger === "contact_lifecycle_updated") {
    return (
      <div>
        <label className="mb-1.5 block text-sm font-medium">To stage (optional)</label>
        <select
          value={(config.toStageId as string) ?? ""}
          onChange={(e) =>
            onChange({ ...config, toStageId: e.target.value || undefined })
          }
          className="h-9 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="">Any stage</option>
          {catalogs.stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-muted-foreground">
          Leave blank to fire on every stage move; pick a stage to scope to it.
        </p>
      </div>
    );
  }
  return null;
}
