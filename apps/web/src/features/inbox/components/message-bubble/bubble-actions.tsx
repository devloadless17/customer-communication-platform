"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Copy,
  CornerUpLeft,
  Flag,
  Forward,
  ListChecks,
  MoreHorizontal,
  SmilePlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMessageFlags } from "@/features/inbox/components/message-flags-context";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";
import { toast } from "@/lib/toast";
import type { Message } from "@ccp/shared/types";

// The universal Meta reaction set (like / love / haha / wow / sad / angry).
// Unlike team-chat's internal set, these go to the CUSTOMER via Meta, so they're
// chosen to be valid on WhatsApp AND the social channels' standard reaction bar.
const QUICK_REACTIONS = ["👍", "❤️", "😆", "😮", "😢", "😠"];

// Instagram's Send API accepts exactly ONE business reaction — a heart (Meta
// maps it to `reaction:"love"`); any other emoji is rejected. So an agent
// reacting on an IG thread only ever gets the heart, and the send layer coerces
// it to "love". WhatsApp/Messenger keep the full bar.
function reactionsForChannel(channel: Message["channel"]): string[] {
  return channel === "instagram" ? ["❤️"] : QUICK_REACTIONS;
}

export function BubbleActions({
  message,
  conversationId,
  canReply,
  canForward,
  canSelect,
  canReact,
  onReply,
  onForward,
  onStartSelect,
}: {
  message: Message;
  conversationId: string;
  canReply: boolean;
  canForward: boolean;
  canSelect: boolean;
  /** We can react to this message with an emoji (any type, either direction). */
  canReact: boolean;
  onReply?: (message: Message) => void;
  onForward?: (message: Message) => void;
  onStartSelect?: (message: Message) => void;
}) {
  // Lightweight reaction bar: a plain toggled popover (no Radix portal / focus
  // trap / backdrop) so it opens instantly and feels weightless — iMessage-style.
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const copyText = message.body.trim();
  const canCopy = copyText.length > 0;
  // Flagging needs a real persisted message (the flag FKs to Message.id) and at
  // least one definition to pick — a team that hasn't set any up sees no entry
  // rather than an empty submenu.
  const flagsCtx = useMessageFlags();
  const alreadyFlagged = new Set((message.flags ?? []).map((f) => f.definition.id));
  const flaggableDefinitions = (flagsCtx?.definitions ?? []).filter(
    (d) => !alreadyFlagged.has(d.id),
  );
  const canFlag =
    Boolean(flagsCtx) && !message.pending && !message.failed && flaggableDefinitions.length > 0;
  const hasMenu =
    canCopy ||
    canFlag ||
    (canForward && Boolean(onForward)) ||
    (canSelect && Boolean(onStartSelect));
  if (!(canReply && onReply) && !hasMenu && !canReact) return null;

  const handleCopy = () => {
    void navigator.clipboard
      .writeText(message.body)
      .then(() => toast.success("Copied"))
      .catch(() => toast.error("Couldn't copy message"));
  };

  const react = async (emoji: string) => {
    try {
      const res = await apiFetch("/api/messages/reaction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, messageId: message.id, emoji }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
        throw new Error(d.detail || d.error || "Couldn't react");
      }
      // The pill renders via the message.reaction_changed socket frame.
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't react");
    }
  };
  return (
    <div
      className={cn(
        "flex items-center gap-0.5 self-center transition-opacity",
        // Keep the whole bar visible while the picker is open (else the bubble's
        // group-hover fade would yank it out from under the cursor mid-pick).
        pickerOpen
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      {canReact && (
        <div ref={pickerRef} className="relative flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setPickerOpen((o) => !o)}
            title="React to this message"
            aria-label="React to this message"
            aria-expanded={pickerOpen}
            className={cn(
              "size-7 pointer-coarse:size-9 text-muted-foreground hover:text-foreground",
              pickerOpen && "text-foreground",
            )}
          >
            <SmilePlus className="size-3.5" />
          </Button>
          {pickerOpen && (
            // The reaction bar itself — a compact rounded pill floating just above
            // the trigger. Fast zoom/fade in, no portal, closes on pick / outside
            // click / Escape.
            <div
              role="menu"
              className="absolute bottom-full left-1/2 z-50 mb-1.5 flex -translate-x-1/2 items-center gap-0.5 rounded-full border bg-popover p-1 shadow-lg animate-in fade-in-0 zoom-in-95 duration-100"
            >
              {reactionsForChannel(message.channel).map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  // Tap the emoji you already reacted with to REMOVE it (WhatsApp
                  // toggle); "" clears our reaction server-side.
                  onClick={() => {
                    void react(message.agentReaction === emoji ? "" : emoji);
                    setPickerOpen(false);
                  }}
                  aria-label={`React ${emoji}`}
                  className={cn(
                    "inline-flex size-8 items-center justify-center rounded-full text-xl leading-none transition-transform hover:scale-125",
                    message.agentReaction === emoji && "bg-accent",
                  )}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {canReply && onReply && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onReply(message)}
          title="Reply to this message"
          aria-label="Reply to this message"
          className="size-7 pointer-coarse:size-9 text-muted-foreground hover:text-foreground"
        >
          <CornerUpLeft className="size-3.5" />
        </Button>
      )}
      {hasMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="More actions"
              aria-label="More actions"
              className="size-7 pointer-coarse:size-9 text-muted-foreground hover:text-foreground"
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {canCopy && (
              <DropdownMenuItem onSelect={handleCopy}>
                <Copy className="size-3.5" />
                Copy
              </DropdownMenuItem>
            )}
            {canFlag && flagsCtx && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Flag className="size-3.5" />
                  Flag as
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-52">
                  {flaggableDefinitions.map((definition) => (
                    <DropdownMenuItem
                      key={definition.id}
                      onSelect={() =>
                        void flagsCtx
                          .raise({ messageId: message.id, definitionId: definition.id })
                          // The toast is already raised inside the context; swallow
                          // here so an expected 4xx doesn't surface as an unhandled
                          // rejection in the console.
                          .catch(() => {})
                      }
                    >
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          tagColorClasses(definition.color).solid,
                        )}
                      />
                      <span className="truncate">{definition.name}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {canForward && onForward && (
              <DropdownMenuItem onSelect={() => onForward(message)}>
                <Forward className="size-3.5" />
                Forward
              </DropdownMenuItem>
            )}
            {canSelect && onStartSelect && (
              <DropdownMenuItem onSelect={() => onStartSelect(message)}>
                <ListChecks className="size-3.5" />
                Select messages
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function FailedRecovery({
  canRetry,
  onRetry,
  onDismiss,
}: {
  canRetry: boolean;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div className="mt-1 flex items-center gap-2 text-3xs text-destructive">
      <AlertCircle className="size-3" />
      <span>Send failed</span>
      {canRetry && onRetry && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <button
            type="button"
            onClick={onRetry}
            className="font-medium hover:underline"
          >
            Retry
          </button>
        </>
      )}
      {onDismiss && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <button
            type="button"
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground hover:underline"
          >
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
