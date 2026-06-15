"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, Loader2 } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/toast";
import { apiFetch } from "@/lib/api/client-fetch";

/**
 * Team-level AI Autopilot opt-in. OFF for every new org — flipping it on
 * surfaces the per-conversation AI toggle in the inbox and enables
 * auto-pause-on-human-reply. Admin-only (the page already gates on
 * canManageUsers). Optimistic with rollback; router.refresh re-renders the
 * RSC so dependent UI (and the inbox on next nav) picks up the change.
 */
export function AiAutopilotToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
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
        </div>
      </div>
    </section>
  );
}
