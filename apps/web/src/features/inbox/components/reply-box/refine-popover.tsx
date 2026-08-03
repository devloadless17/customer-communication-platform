"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Check, Loader2, PenLine, Scissors, SmilePlus, SpellCheck, Undo2, X } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";

type RefineMode = "formal" | "friendly" | "shorten" | "grammar";

/**
 * Composer "AI refine" popover (Gmail-Polish-style: Formalise / Friendly /
 * Shorten / Fix grammar). Clicking a mode POSTs the current composer text to
 * /api/messages/refine and shows the result as a PREVIEW — the
 * draft is only overwritten on "Apply" (calls `onRefined`), so an accidental
 * click can never destroy a typed draft. Mirrors TranslatePopover's
 * preview → Apply/Cancel → Undo shape exactly.
 */
const MODES: Array<{ mode: RefineMode; label: string; icon: typeof PenLine }> = [
  { mode: "formal", label: "Formalise", icon: PenLine },
  { mode: "friendly", label: "Friendly", icon: SmilePlus },
  { mode: "shorten", label: "Shorten", icon: Scissors },
  { mode: "grammar", label: "Fix grammar", icon: SpellCheck },
];

export function RefinePopover({
  open,
  onClose,
  text,
  onRefined,
}: {
  open: boolean;
  onClose: () => void;
  /** Current composer text to refine. */
  text: string;
  /** Replaces the composer content with the refined text. */
  onRefined: (refined: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<RefineMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ label: string; text: string } | null>(null);
  const [applied, setApplied] = useState<{ label: string; original: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onClick(e: MouseEvent) {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) {
      setError(null);
      setPreview(null);
      setApplied(null);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    };
  }, []);

  if (!open) return null;

  const hasText = text.trim().length > 0;

  function applyPreview() {
    if (!preview) return;
    const original = text;
    onRefined(preview.text);
    setApplied({ label: preview.label, original });
    setPreview(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => {
      setApplied(null);
      onClose();
    }, 5000);
  }
  function undoApply() {
    if (!applied) return;
    onRefined(applied.original);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setApplied(null);
    onClose();
  }
  function cancelPreview() {
    setPreview(null);
    setError(null);
  }

  async function refine(mode: RefineMode, label: string) {
    if (!hasText || pending) return;
    setPending(mode);
    setError(null);
    try {
      const res = await apiFetch("/api/messages/refine", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, mode }),
      });
      if (!res.ok) {
        let msg = "Refinement failed.";
        try {
          const j = (await res.json()) as { error?: string; message?: string };
          msg = j.message ?? j.error ?? msg;
        } catch {
          // non-JSON error body — keep the default message
        }
        setError(msg);
        return;
      }
      const json = (await res.json()) as { text?: string };
      if (typeof json.text === "string") {
        setPreview({ label, text: json.text });
      } else {
        setError("Refinement returned no result.");
      }
    } catch {
      setError("Couldn't reach the refinement service.");
    } finally {
      setPending(null);
    }
  }

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.12 }}
      className="absolute bottom-full left-0 z-50 mb-2 w-56 overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
    >
      {applied ? (
        <div>
          <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Applied</span>
            <span className="normal-case">{applied.label}</span>
          </div>
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Check className="size-3.5 shrink-0 text-primary" />
              <span>Draft replaced.</span>
            </div>
            <button
              type="button"
              onClick={undoApply}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Undo2 className="size-3.5" /> Undo
            </button>
          </div>
        </div>
      ) : preview ? (
        <div>
          <div className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            <span>{preview.label}</span>
          </div>
          <div
            dir="auto"
            className="max-h-40 overflow-y-auto whitespace-pre-wrap wrap-break-word px-3 py-2.5 text-sm leading-relaxed"
          >
            {preview.text}
          </div>
          <div className="flex items-center justify-end gap-1.5 border-t border-border px-2 py-2">
            <button
              type="button"
              onClick={cancelPreview}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" /> Cancel
            </button>
            <button
              type="button"
              onClick={applyPreview}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Check className="size-3.5" /> Apply
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="border-b border-border px-3 py-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Refine with AI
          </div>
          {!hasText ? (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground">
              Type a message first.
            </div>
          ) : (
            <ul className="py-1">
              {MODES.map(({ mode, label, icon: Icon }) => (
                <li key={mode}>
                  <button
                    type="button"
                    onClick={() => void refine(mode, label)}
                    disabled={pending !== null}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                      pending !== null && "cursor-wait opacity-60",
                    )}
                  >
                    <Icon className="size-3.5 shrink-0 opacity-70" />
                    <span className="flex-1">{label}</span>
                    {pending === mode && (
                      <Loader2 className="size-3.5 animate-spin opacity-70" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && (
        <div className="border-t border-border px-3 py-2 text-2xs text-destructive">
          {error}
        </div>
      )}
    </motion.div>
  );
}
