"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Check, Loader2, Undo2, X } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";

/**
 * Composer "translate" popover. Lists target languages; clicking one POSTs the
 * current composer text to /api/messages/translate (Claude API) and shows the
 * result as a PREVIEW. The draft is only overwritten when the agent presses
 * "Apply" (calls `onTranslated`); "Cancel" discards the preview and returns to
 * the language list — so an accidental click can never destroy a typed draft.
 *
 * Positioned upward (the toolbar sits at the bottom of the composer), anchored
 * left to the trigger. Click-outside + Escape close it (same as the emoji
 * popover). The `label` is sent as the target language name.
 */
const LANGUAGES: Array<{ label: string; flag: string }> = [
  { label: "Arabic", flag: "🇸🇦" },
  { label: "English", flag: "🇺🇸" },
  { label: "French", flag: "🇫🇷" },
  { label: "Spanish", flag: "🇪🇸" },
  { label: "German", flag: "🇩🇪" },
  { label: "Italian", flag: "🇮🇹" },
  { label: "Portuguese", flag: "🇵🇹" },
  { label: "Dutch", flag: "🇳🇱" },
  { label: "Russian", flag: "🇷🇺" },
  { label: "Turkish", flag: "🇹🇷" },
  { label: "Chinese", flag: "🇨🇳" },
  { label: "Japanese", flag: "🇯🇵" },
];

export function TranslatePopover({
  open,
  onClose,
  text,
  onTranslated,
}: {
  open: boolean;
  onClose: () => void;
  /** Current composer text to translate. */
  text: string;
  /** Replaces the composer content with the translated text. */
  onTranslated: (translated: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<string | null>(null); // lang code in flight
  const [error, setError] = useState<string | null>(null);
  // When set, the popover shows the translated text as a PREVIEW with
  // Apply / Cancel instead of the language list. The draft is NOT touched
  // until Apply. `language` is kept for the preview header label.
  const [preview, setPreview] = useState<{ language: string; text: string } | null>(
    null,
  );
  // After Apply, the popover stays open for a few seconds showing an Undo
  // affordance. `applied.original` is the pre-translate draft we replaced;
  // Undo re-sets the composer to it via onTranslated(original). Auto-closes
  // on the timer so the popover never lingers.
  const [applied, setApplied] = useState<{ language: string; original: string } | null>(
    null,
  );
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

  // Clear any pending undo timer on unmount / close so it can't fire after.
  useEffect(() => {
    return () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    };
  }, []);

  if (!open) return null;

  const hasText = text.trim().length > 0;

  function applyPreview() {
    if (!preview) return;
    const original = text; // stash the draft we're about to overwrite (for Undo)
    onTranslated(preview.text); // the single point that overwrites the draft
    // Keep the popover open briefly with an Undo affordance instead of
    // closing immediately. A one-click Undo re-sets the composer to the
    // original draft (the parent already drives the value from onTranslated).
    setApplied({ language: preview.language, original });
    setPreview(null); // clear before showing applied so a re-open never flashes it
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => {
      setApplied(null);
      onClose();
    }, 5000);
  }
  function undoApply() {
    if (!applied) return;
    onTranslated(applied.original); // restore the pre-translate draft
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setApplied(null);
    onClose();
  }
  function cancelPreview() {
    setPreview(null); // back to the language list; draft untouched
    setError(null);
  }

  async function translate(language: string) {
    if (!hasText || pending) return;
    setPending(language);
    setError(null);
    try {
      const res = await apiFetch("/api/messages/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, targetLang: language }),
      });
      if (!res.ok) {
        let msg = "Translation failed.";
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
        // Non-destructive: show the result as a preview. The composer draft is
        // only overwritten when the agent presses Apply (applyPreview).
        setPreview({ language, text: json.text });
      } else {
        setError("Translation returned no result.");
      }
    } catch {
      setError("Couldn't reach the translation service.");
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
            <span>Applied to</span>
            <span className="normal-case">{applied.language}</span>
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
            <span>Translated to</span>
            <span className="normal-case">{preview.language}</span>
          </div>
          {/* Read-only preview — the draft is NOT changed until Apply. */}
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
            Translate to
          </div>
          {!hasText ? (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground">
              Type a message first.
            </div>
          ) : (
            <ul className="max-h-64 overflow-y-auto py-1">
              {LANGUAGES.map((lang) => (
                <li key={lang.label}>
                  <button
                    type="button"
                    onClick={() => void translate(lang.label)}
                    disabled={pending !== null}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                      pending !== null && "cursor-wait opacity-60",
                    )}
                  >
                    <span className="text-base leading-none">{lang.flag}</span>
                    <span className="flex-1">{lang.label}</span>
                    {pending === lang.label && (
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
