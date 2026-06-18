"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Loader2 } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/lib/api/client-fetch";

type HandoffAction = "none" | "unassign" | "assign_fixed" | "round_robin";
type FirstTouchGreeter = "ai" | "workflow";

interface AiSettings {
  enabled: boolean;
  handoffAction: HandoffAction;
  handoffAssigneeId: string | null;
  firstTouchGreeter: FirstTouchGreeter;
  sessionGapMinutes: number;
}

interface Member {
  id: string;
  name: string;
  email: string;
}

/**
 * Team-level AI Autopilot settings. The on/off opt-in (top) controls whether
 * the per-conversation AI controls + auto-pause exist at all; the rest
 * (handoff behavior, first-touch greeting, session window) only render once
 * it's on. Admin-only (the page gates on canManageUsers).
 */
export function AiAutopilotToggle({
  initial,
  members,
}: {
  initial: AiSettings;
  members: Member[];
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function toggle() {
    if (pending) return;
    const next = !enabled;
    setPending(true);
    setEnabled(next);
    try {
      const res = await apiFetch("/api/team/ai-autopilot", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aiAutopilotEnabled: next }),
      });
      if (!res.ok) {
        setEnabled(!next);
        toast.error("Couldn't update AI Autopilot");
        return;
      }
      toast.success(next ? "AI Autopilot enabled" : "AI Autopilot disabled");
      router.refresh();
    } catch {
      setEnabled(!next);
      toast.error("Network error");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Bot className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">AI Autopilot</h2>
            <span className="relative inline-flex shrink-0">
              <Switch
                checked={enabled}
                onCheckedChange={() => void toggle()}
                disabled={pending}
                aria-label="AI Autopilot"
                title={
                  enabled
                    ? "AI Autopilot is on — click to disable"
                    : "AI Autopilot is off — click to enable"
                }
              />
              {pending && (
                <Loader2 className="pointer-events-none absolute inset-0 m-auto size-3 animate-spin text-foreground/60" />
              )}
            </span>
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Let an external AI flow (e.g. n8n) auto-reply to customers. When on,
            every conversation gets an <span className="font-medium">AI on/off</span> toggle,
            and the AI <span className="font-medium">auto-pauses the moment an agent replies</span>{" "}
            or the customer asks for a human — so it never talks over a person.
            Requires an API key + an outbound webhook (above) wired to your AI flow.
          </p>

          {enabled && (
            <AiBehaviorSettings initial={initial} members={members} />
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * The behavior knobs that only matter once Autopilot is on. Saved together via
 * PATCH /api/team/ai-settings (the server validates assign_fixed → real member).
 */
function AiBehaviorSettings({
  initial,
  members,
}: {
  initial: AiSettings;
  members: Member[];
}) {
  const [handoffAction, setHandoffAction] = useState<HandoffAction>(initial.handoffAction);
  const [assigneeId, setAssigneeId] = useState<string>(initial.handoffAssigneeId ?? "");
  const [firstTouch, setFirstTouch] = useState<FirstTouchGreeter>(initial.firstTouchGreeter);
  const [sessionGap, setSessionGap] = useState<string>(String(initial.sessionGapMinutes));
  const [saving, setSaving] = useState(false);
  const router = useRouter();

  const activeMembers = members; // server re-validates; show all for selection

  async function save() {
    if (saving) return;
    if (handoffAction === "assign_fixed" && !assigneeId) {
      toast.error("Pick a team member to assign handoffs to");
      return;
    }
    const gap = Number(sessionGap);
    if (!Number.isFinite(gap) || gap < 1) {
      toast.error("Session gap must be at least 1 minute");
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch("/api/team/ai-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aiHandoffAction: handoffAction,
          // Only meaningful for assign_fixed; null otherwise so a stale pick
          // doesn't linger on the row.
          aiHandoffAssigneeId:
            handoffAction === "assign_fixed" ? assigneeId : null,
          firstTouchGreeter: firstTouch,
          sessionGapMinutes: Math.round(gap),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { detail?: string } | null;
        toast.error(body?.detail ?? "Couldn't save AI settings");
        return;
      }
      toast.success("AI settings saved");
      router.refresh();
    } catch {
      toast.error("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      {/* Handoff action */}
      <div>
        <label className="text-xs font-medium">When a customer asks for a human</label>
        <p className="mb-2 text-2xs text-muted-foreground">
          The AI pauses for that conversation either way. This picks what happens
          to the thread next.
        </p>
        <Select
          value={handoffAction}
          onChange={(e) => setHandoffAction(e.target.value as HandoffAction)}
          className="h-8"
        >
          <option value="none">Just pause the AI</option>
          <option value="unassign">Pause + leave unassigned</option>
          <option value="assign_fixed">Pause + assign to a specific member</option>
          <option value="round_robin">Pause + round-robin to available agents</option>
        </Select>
        {handoffAction === "assign_fixed" && (
          <Select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className="mt-2 h-8"
          >
            <option value="">Select a member…</option>
            {activeMembers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.email})
              </option>
            ))}
          </Select>
        )}
      </div>

      {/* First-touch greeting */}
      <div>
        <label className="text-xs font-medium">First-touch greeting</label>
        <p className="mb-2 text-2xs text-muted-foreground">
          Who greets on a brand-new conversation, so the AI and a welcome
          workflow don't both reply to the first message.
        </p>
        <Select
          value={firstTouch}
          onChange={(e) => setFirstTouch(e.target.value as FirstTouchGreeter)}
          className="h-8"
        >
          <option value="ai">AI greets (don&apos;t run a welcome workflow)</option>
          <option value="workflow">Workflow greets (AI stays silent on the first message)</option>
        </Select>
      </div>

      {/* Session window */}
      <div>
        <label className="text-xs font-medium">New-session gap (minutes)</label>
        <p className="mb-2 text-2xs text-muted-foreground">
          After this much inbound silence, a customer&apos;s next message counts as
          a new chatting session (drives the <code>session_kind</code> workflow
          condition). Default 360 (6h).
        </p>
        <Input
          type="number"
          min={1}
          value={sessionGap}
          onChange={(e) => setSessionGap(e.target.value)}
          className="h-8 w-32"
        />
      </div>

      <Button size="sm" onClick={() => void save()} disabled={saving}>
        {saving && <Loader2 className="size-3 animate-spin" />}
        Save AI settings
      </Button>
    </div>
  );
}
