"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useSocketReconnect } from "@/hooks/use-socket-reconnect";
import { apiFetch } from "@/lib/api/client-fetch";
import { getClientSocket } from "@/lib/socket-client";

/**
 * Conversation-header AI state chip + actions (placement map §4):
 *   states  : AI Active · Human Active · Paused
 *   actions : Pause AI · Resume AI · Take over · Return to AI
 * No separate "disable" — pause/resume is the only agent-facing control
 * (removed 2026-07). A paused conversation also auto-resumes on its own if
 * the customer reopens it after a close (server-side, see
 * conversation-state.ts `resumeOnReopen`) — this chip just reflects whatever
 * the server reports.
 * Reflects the server state machine (correction #2). Persisted, so it survives
 * refresh; refetched on mount.
 */

type State = "ai_active" | "human_active" | "ai_paused";

const META: Record<State, { label: string; className: string }> = {
  ai_active: { label: "AI Active", className: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300" },
  human_active: { label: "Human Active", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300" },
  ai_paused: { label: "AI Paused", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
};

const ACTIONS: Record<State, Array<[string, string]>> = {
  ai_active: [["Pause AI", "pause"], ["Take over", "takeover"]],
  human_active: [["Return to AI", "resume"], ["Pause AI", "pause"]],
  ai_paused: [["Resume AI", "resume"]],
};

export function AiStateControl({
  conversationId,
  onState,
}: {
  conversationId: string;
  /** Report the resolved AI state up so the header can label the assignee as
   *  "AI Agent" while the assistant is active — reuses this component's fetch. */
  onState?: (state: State | null) => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onState?.(state);
  }, [state, onState]);

  const load = useCallback(async () => {
    const res = await apiFetch(`/api/ai-assistant/conversations/${conversationId}/overview`);
    if (!res.ok) return;
    const data = (await res.json()) as { state?: State };
    if (data.state) setState(data.state);
  }, [conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // §10 convergence: `ai:state` is a rare frame with nothing steady behind it,
  // so one missed during a drop past the socket recovery window would leave the
  // chip (and the header's "AI Agent" assignee label) wrong until a refresh.
  useSocketReconnect(load);

  // Realtime: reflect state changes made elsewhere (ai.state_changed).
  useEffect(() => {
    const socket = getClientSocket();
    const onState = (p: { workspaceId: string; conversationId: string; state: string }) => {
      if (p.conversationId === conversationId) setState(p.state as State);
    };
    socket.on("ai:state", onState);
    return () => {
      socket.off("ai:state", onState);
    };
  }, [conversationId]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  async function act(action: string) {
    setOpen(false);
    const res = await apiFetch(`/api/ai-assistant/conversations/${conversationId}/state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (res.ok) {
      const data = (await res.json()) as { state?: { state?: State } };
      if (data.state?.state) setState(data.state.state);
      else void load();
    }
  }

  // A defensive fallback: the server can no longer produce anything outside
  // `META`'s keys, but a not-yet-migrated legacy row (state="disabled") could
  // theoretically still surface one during a rollout window — don't crash.
  if (!state || !(state in META)) return null;
  const meta = META[state];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`rounded-full px-2 py-1 text-xs font-medium ${meta.className}`}
        title="AI Assistant state"
      >
        {meta.label}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 min-w-40 rounded-md border border-border bg-popover p-1 shadow-md">
          {ACTIONS[state].map(([label, action]) => (
            <button
              key={action}
              onClick={() => void act(action)}
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
