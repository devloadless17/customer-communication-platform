"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";

import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";

/**
 * Composer "translate" popover. Lists target languages; clicking one POSTs the
 * current composer text to /api/messages/translate (Claude API) and replaces
 * the draft with the result via `onTranslated`.
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
    if (open) setError(null);
  }, [open]);

  if (!open) return null;

  const hasText = text.trim().length > 0;

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
        onTranslated(json.text);
        onClose();
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
      className="absolute bottom-full left-0 z-30 mb-2 w-56 overflow-hidden rounded-xl border border-border bg-popover shadow-xl"
    >
      <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Translate to
      </div>
      {!hasText ? (
        <div className="px-3 py-3 text-center text-[12px] text-muted-foreground">
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
                  "flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-accent/60",
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
      {error && (
        <div className="border-t border-border px-3 py-2 text-[11px] text-destructive">
          {error}
        </div>
      )}
    </motion.div>
  );
}
