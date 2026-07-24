"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api/client-fetch";
import { toast } from "@/lib/toast";

import type { AssignmentSettingsRow, PolicyRow } from "./types";

/**
 * The switchboard: WHEN routing runs at all.
 *
 * Everything here ships OFF except `reassignOnDeactivate`, so enabling the
 * feature changes nothing until an admin opts in — the same posture as the AI
 * autopilot toggle. Each switch persists immediately (they're independent
 * booleans, unlike a policy's interdependent fields) and carries the settings
 * `version` so a co-admin's concurrent change surfaces instead of being
 * clobbered.
 */
export function AutomationPanel({
  settings,
  policies,
  onChanged,
}: {
  settings: AssignmentSettingsRow;
  policies: PolicyRow[];
  onChanged: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);

  const patch = async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await apiFetch("/api/workspace/assignment/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, expectedVersion: settings.version }),
      });
      if (res.status === 409) {
        toast("Someone else changed these settings — reloading");
        await onChanged();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await onChanged();
    } catch {
      toast("Couldn't save — reverted");
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {saving && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Saving…
        </div>
      )}

      <Group
        title="New conversations"
        description="What happens the moment a customer messages for the first time."
      >
        <Toggle
          label="Assign new conversations automatically"
          hint="A brand-new conversation is routed through your teams as soon as the first message arrives. Off means every new chat waits in the Unassigned queue for someone to claim it."
          checked={settings.autoAssignOnNewConversation}
          onChange={(v) => void patch({ autoAssignOnNewConversation: v })}
        />
        {settings.autoAssignOnNewConversation && (
          <Toggle
            indent
            label="Let the AI handle it first"
            hint="While the AI assistant is answering, don't spend an agent's capacity on the conversation. A human is routed in the moment the AI escalates. Turn this off if you want every conversation to have a named owner from the first message, even while the AI replies."
            checked={settings.skipWhenAiHandling}
            onChange={(v) => void patch({ skipWhenAiHandling: v })}
          />
        )}
        <Toggle
          label="Assign when an unassigned conversation gets a new message"
          hint="Covers reopened threads and ones a teammate deliberately unassigned. A conversation that already has an owner is never touched."
          checked={settings.autoAssignOnReopen}
          onChange={(v) => void patch({ autoAssignOnReopen: v })}
        />
      </Group>

      <Group
        title="What agents can see"
        description="Admins and managers always see every conversation."
      >
        <div className="space-y-1.5">
          <Select
            value={settings.agentConversationVisibility}
            onChange={(e) =>
              void patch({ agentConversationVisibility: e.target.value })
            }
          >
            <option value="team">Agents see every conversation</option>
            <option value="assigned">Agents see only conversations assigned to them</option>
          </Select>
          <p className="text-xs text-muted-foreground">
            {settings.agentConversationVisibility === "assigned" ? (
              <>
                Agents see only their own conversations — in the list, in search,
                in counts and in notifications. Handing a conversation over works
                normally: the new owner immediately sees the{" "}
                <span className="font-medium text-foreground">whole history</span>,
                including everything the previous agent said, and the previous
                agent loses access at the same moment. Anyone already signed in
                picks up the change within about 15 seconds, or on their next
                page load.
              </>
            ) : (
              "Everyone on the team can open any conversation. Best for small teams that cover for each other."
            )}
          </p>
        </div>
      </Group>

      <Group
        title="AI handoff"
        description="Which team a conversation goes to when the AI hands it to a human."
      >
        <div className="space-y-1.5">
          <Select
            value={settings.aiHandoffPolicyId ?? ""}
            onChange={(e) => void patch({ aiHandoffPolicyId: e.target.value || null })}
          >
            <option value="">Use my routing rules (default)</option>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            Pin escalations to a dedicated pool — &ldquo;senior agents only&rdquo; — or leave
            it on the routing rules so an escalation follows the same logic as
            everything else. A policy set to &ldquo;never auto-assign&rdquo; is the supported
            way to say &ldquo;escalate, but leave it in the queue&rdquo;.
          </p>
        </div>
      </Group>

      <Group
        title="Keeping work with someone who's there"
        description="Move conversations off agents who are no longer available."
      >
        <Toggle
          label="Reassign when an agent goes offline"
          hint="Conversations sitting with someone who has closed the app get re-routed. Only conversations where no agent has replied yet are moved by default, so nobody is pulled out of a live exchange."
          checked={settings.reassignOnOffline}
          onChange={(v) => void patch({ reassignOnOffline: v })}
        />
        {settings.reassignOnOffline && (
          <>
            <div className="ml-11 flex items-center gap-2">
              <span className="text-sm">Wait</span>
              <Input
                type="number"
                min={1}
                max={1440}
                className="w-20 text-right"
                defaultValue={settings.reassignOfflineAfterMinutes}
                onBlur={(e) => {
                  const value = Number(e.target.value);
                  if (
                    Number.isFinite(value) &&
                    value >= 1 &&
                    value <= 1440 &&
                    value !== settings.reassignOfflineAfterMinutes
                  ) {
                    void patch({ reassignOfflineAfterMinutes: value });
                  }
                }}
              />
              <span className="text-sm text-muted-foreground">
                minutes before moving anything
              </span>
            </div>
            <Toggle
              indent
              label="Only move conversations nobody has replied to yet"
              hint="Strongly recommended. A conversation an agent is mid-exchange on carries context; handing it to someone else mid-sentence is worse for the customer than a short wait."
              checked={settings.reassignOfflineOnlyPending}
              onChange={(v) => void patch({ reassignOfflineOnlyPending: v })}
            />
          </>
        )}
        <Toggle
          label="Reassign when a teammate is deactivated"
          hint="Their open conversations are routed to someone else immediately. Without this they sit with an account that can no longer log in, and never appear in anyone's queue."
          checked={settings.reassignOnDeactivate}
          onChange={(v) => void patch({ reassignOnDeactivate: v })}
        />
      </Group>
    </div>
  );
}

function Group({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="space-y-4 rounded-lg border border-border px-4 py-4">{children}</div>
    </section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  indent,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  indent?: boolean;
}) {
  return (
    <label className={"flex items-start gap-3" + (indent ? " ml-8" : "")}>
      <Switch checked={checked} onCheckedChange={onChange} />
      <span className="text-sm">
        {label}
        <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
