"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import type { SnippetItem } from "@ccp/shared/types";

export type { SnippetItem };

/**
 * Slash-trigger popup for the reply composer.
 *
 *   1. Parent watches its textarea's value+caret and computes a "slash query"
 *      — the `/foo` immediately preceding the cursor on the current word.
 *   2. Parent passes the query in via `query` (null = closed).
 *   3. We filter the snippet list, render a small floating list above the
 *      textarea, and let the user navigate with ↓/↑/Enter/Tab/Esc.
 *
 * Keyboard handling: we attach a keydown listener on `window` while open
 * (the textarea keeps focus so we don't try to intercept React synthetic
 * events on it — that would fight the parent's own keydown handler used
 * for shift-enter, etc.). Arrow keys are preventDefault'd to keep the
 * caret put; Enter/Tab insert; Esc just closes.
 */

export function SnippetPopup({
  snippets,
  query,
  onSelect,
  onClose,
}: {
  snippets: SnippetItem[];
  /** The string typed after `/`, or null when the popup should be hidden. */
  query: string | null;
  /** Called with the chosen snippet when the user commits a selection. */
  onSelect: (s: SnippetItem) => void;
  /** Called on Esc, outside-click, or empty query. */
  onClose: () => void;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    if (query === null) return [];
    const q = query.trim().toLowerCase();
    // Empty `/` shows the full list; otherwise prefix-then-substring match
    // so the most-direct trigger lookups land at the top of the picker.
    if (q.length === 0) return snippets.slice(0, 8);
    const starts: SnippetItem[] = [];
    const contains: SnippetItem[] = [];
    for (const s of snippets) {
      const n = s.name.toLowerCase();
      const l = s.label.toLowerCase();
      if (n.startsWith(q) || l.startsWith(q)) {
        starts.push(s);
      } else if (n.includes(q) || l.includes(q)) {
        contains.push(s);
      }
    }
    return [...starts, ...contains].slice(0, 8);
  }, [snippets, query]);

  // Reset selection on every query change so the highlighted row makes sense.
  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  // Keep the highlighted row scrolled into view when the user arrows through.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  // Global keydown — Arrow/Enter/Tab/Esc. Mounted only while open. Registered
  // in CAPTURE phase so Escape closes only THIS popup, not also the layer
  // beneath it (e.g. message-selection mode) — `stopImmediatePropagation`
  // keeps the single keystroke from cascading through every Escape handler.
  useEffect(() => {
    if (query === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(matches.length - 1, i + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (matches.length === 0) return;
        e.preventDefault();
        const m = matches[activeIdx];
        if (m) onSelect(m);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [query, matches, activeIdx, onSelect, onClose]);

  if (query === null) return null;

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-3 mb-2 z-30 w-72 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
      // Stop the textarea from losing focus when the user clicks an entry —
      // we want the caret to stay put so the replacement can find it.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="flex items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Sparkles className="size-3 text-primary" />
        <span>Snippets</span>
        <span className="ml-auto font-mono text-3xs normal-case text-muted-foreground">
          {query ? `/${query}` : "/"}
        </span>
      </div>
      {matches.length === 0 ? (
        <div className="px-3 py-3 text-[12px] text-muted-foreground">
          No snippets match{" "}
          <code className="rounded bg-muted px-1 font-mono">/{query}</code>.
        </div>
      ) : (
        <ul className="max-h-60 overflow-y-auto">
          {matches.map((s, i) => (
            <li key={s.id}>
              <button
                data-idx={i}
                type="button"
                onMouseEnter={() => setActiveIdx(i)}
                onClick={() => onSelect(s)}
                className={cn(
                  "flex w-full items-start gap-2 px-3 py-2 text-left transition-colors",
                  i === activeIdx ? "bg-primary/10" : "hover:bg-accent/40",
                )}
              >
                <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded bg-primary/10 font-mono text-3xs font-bold text-primary">
                  /
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">
                    {s.label}
                  </span>
                  <span className="block truncate font-mono text-[10.5px] text-muted-foreground">
                    /{s.name} · {compact(s.body)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-border bg-muted/30 px-3 py-1.5 text-3xs text-muted-foreground">
        <span className="font-mono">↑↓</span> navigate · <span className="font-mono">↵</span> insert ·{" "}
        <span className="font-mono">Esc</span> close
      </div>
    </div>
  );
}

function compact(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 60 ? single.slice(0, 57) + "…" : single;
}
