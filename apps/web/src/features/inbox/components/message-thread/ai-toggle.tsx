"use client";

import { useState } from "react";
import { Bot, BotOff, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@ccp/shared/utils";
import {
  dispatchLocalSocketEvent,
  dispatchLocalSocketEvents,
} from "@/lib/socket-client";
import { apiFetch } from "@/lib/api/client-fetch";
import {
  buildOptimisticAiChange,
  rollbackOptimisticActivity,
} from "@/features/inbox/lib/optimistic-activity";

import { readError } from "./utils";

/**
 * AI Autopilot toggle — pause/resume the external AI auto-reply for this
 * conversation. Optimistic: fans the same `conversation:ai` socket frame +
 * activity pill the server will broadcast so the header, list, and timeline
 * flip in one paint, then rolls back on failure. Mirrors StatusDropdown.
 *
 * Note: replying to a customer auto-pauses the AI server-side, so this button
 * is mainly for explicitly muting without replying, or resuming after a
 * handoff. The displayed value is driven by the live conversation state
 * (applyConversationAi reducer), so the auto-pause flips it without a refresh.
 */
export function AiToggle({
  teamId,
  conversationId,
  aiEnabled,
  currentUserName,
  onAlert,
}: {
  teamId: string;
  conversationId: string;
  aiEnabled: boolean;
  /** Actor name for the optimistic activity pill. */
  currentUserName: string;
  onAlert: (title: string, description?: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  const toggle = async () => {
    if (pending) return;
    const next = !aiEnabled;
    setPending(true);
    const activity = buildOptimisticAiChange({
      teamId,
      conversationId,
      actorName: currentUserName,
      aiEnabled: next,
    });
    dispatchLocalSocketEvents([
      ["conversation:ai", { teamId, conversationId, aiEnabled: next, optimistic: true }],
      activity.frame,
    ]);
    const rollback = () => {
      dispatchLocalSocketEvent("conversation:ai", { teamId, conversationId, aiEnabled });
      rollbackOptimisticActivity(teamId, conversationId, activity.id);
    };
    try {
      const res = await apiFetch(`/api/conversations/${conversationId}/ai`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ aiEnabled: next }),
      });
      if (!res.ok) {
        rollback();
        await onAlert("Couldn't change AI Autopilot", await readError(res));
      }
    } catch (err) {
      rollback();
      await onAlert(
        "Couldn't change AI Autopilot",
        err instanceof Error ? err.message : "Network error",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      // A toggle, not a menu — so it must NOT mimic the outline dropdown chrome
      // next to it. ON = filled primary tint + border (reads "pressed/active");
      // OFF = plain outline, muted. No chevron (nothing opens on click).
      className={cn(
        "h-8 gap-1.5",
        aiEnabled
          ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
          : "text-muted-foreground",
      )}
      disabled={pending}
      onClick={() => void toggle()}
      aria-pressed={aiEnabled}
      aria-label={aiEnabled ? "AI Autopilot is on — click to pause" : "AI Autopilot is off — click to resume"}
      title={
        aiEnabled
          ? "AI Autopilot is on — click to pause and handle this conversation yourself"
          : "AI Autopilot is paused — click to let the AI reply again"
      }
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : aiEnabled ? (
        <Bot className="size-3.5" />
      ) : (
        <BotOff className="size-3.5" />
      )}
      {/* Label collapses below @2xl, same as the assignment + status triggers,
          leaving the Bot/BotOff icon. The pressed tint carries the on/off
          state when the text is hidden. */}
      <span className="hidden font-normal @2xl:inline">{aiEnabled ? "AI on" : "AI off"}</span>
    </Button>
  );
}
