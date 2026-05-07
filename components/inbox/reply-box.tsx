"use client";

import { useRef, useState } from "react";
import { Paperclip, Send, Smile, StickyNote, MessageSquare } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Mode = "reply" | "note";

/**
 * Reply composer with Reply/Note toggle. Send is a no-op in Phase 0 — the
 * onSubmit hook lands when we wire the provider in Week 2.
 */
export function ReplyBox({ conversationId: _conversationId }: { conversationId: string }) {
  const [mode, setMode] = useState<Mode>("reply");
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const isNote = mode === "note";

  const submit = () => {
    if (!value.trim()) return;
    // TODO(week 2): call provider.sendText for reply mode, write to internal_notes for note mode.
    setValue("");
    ref.current?.focus();
  };

  return (
    <div className="border-t border-border bg-background">
      <div className="mx-auto w-full max-w-3xl px-4 pt-3 pb-4">
        <div className="mb-2 inline-flex rounded-md border border-border bg-muted/40 p-0.5">
          <ToggleButton active={mode === "reply"} onClick={() => setMode("reply")} icon={MessageSquare} label="Reply" />
          <ToggleButton active={mode === "note"} onClick={() => setMode("note")} icon={StickyNote} label="Note" />
        </div>

        <motion.div
          layout
          className={cn(
            "relative rounded-xl border transition-colors",
            isNote ? "border-note-border bg-note-bg/40" : "border-border bg-card",
          )}
        >
          <Textarea
            ref={ref}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              isNote
                ? "Leave an internal note for your teammates…"
                : "Reply on WhatsApp…"
            }
            className="min-h-[88px] resize-none border-0 bg-transparent px-3.5 py-3 text-sm shadow-none focus-visible:ring-0"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="flex items-center gap-1 px-2 pb-2 pt-0">
            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground">
              <Paperclip className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground">
              <Smile className="size-4" />
            </Button>

            <AnimatePresence>
              {isNote && (
                <motion.span
                  key="note-tag"
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -4 }}
                  className="ml-1 text-[11px] font-medium text-note-fg"
                >
                  Internal · not sent to WhatsApp
                </motion.span>
              )}
            </AnimatePresence>

            <span className="ml-auto text-[10px] text-muted-foreground">⌘ ↵ to send</span>
            <Button
              size="sm"
              onClick={submit}
              disabled={!value.trim()}
              className={cn(
                "h-8 gap-1.5",
                isNote && "bg-note-fg text-background hover:bg-note-fg/90",
              )}
            >
              <Send className="size-3.5" />
              {isNote ? "Save note" : "Send"}
            </Button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof MessageSquare;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {active && (
        <motion.span
          layoutId="reply-toggle-pill"
          className="absolute inset-0 rounded bg-card shadow-xs ring-1 ring-border"
          transition={{ type: "spring", duration: 0.25, bounce: 0.18 }}
        />
      )}
      <Icon className="relative size-3.5" />
      <span className="relative">{label}</span>
    </button>
  );
}
