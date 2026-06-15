"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Search as SearchIcon,
  X,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { cn } from "@ccp/shared/utils";
import type { MediaKind, MessageDirection } from "@ccp/shared/types";

/**
 * WhatsApp-style in-thread message search.
 *
 * Renders as a slim bar beneath the thread header — NOT a results dropdown.
 * Matches are highlighted IN PLACE inside the existing chat bubbles (text
 * highlight via `<mark>`, the currently-active match gets a yellow ring).
 * ↑/↓ navigates between matches; the parent thread fetches a context window
 * when the active match is off-slice so the scroll-to lands on a real DOM
 * node.
 *
 * Owns:
 *   - the search input
 *   - the debounced fetch against /messages/search
 *   - emitting matches + active-index changes up to the thread
 *
 * Does NOT own:
 *   - the scroll-to-match behavior (the thread does that with refs)
 *   - the highlight rendering (MessageBubble does that with `searchQuery`)
 */

export interface SearchHit {
  id: string;
  body: string;
  direction: MessageDirection;
  timestamp: string;
  senderName: string | null;
  mediaCaption?: string;
  mediaKind?: MediaKind;
}

interface SearchPage {
  items: SearchHit[];
  nextCursor: string | null;
  totalMatched: number;
}

export function MessageSearch({
  conversationId,
  onMatchesChange,
  onQueryChange,
  onActiveIndexChange,
  activeIndex,
  totalMatches,
  onClose,
}: {
  conversationId: string;
  /** Fires when the result set changes — either a fresh query or a cleared
   *  query (then `matches` is empty). The thread snapshots this and uses
   *  it to drive highlighting + navigation. */
  onMatchesChange: (matches: SearchHit[]) => void;
  /** Fires on every keystroke so the thread can highlight the text. */
  onQueryChange: (query: string) => void;
  /** Parent owns the cursor so navigation state survives keyboard repeats. */
  onActiveIndexChange: (next: number) => void;
  activeIndex: number;
  totalMatches: number;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Server-reported total match count (independent of how many we loaded). The
  // display shows this so the count is accurate even past the load cap.
  const [totalMatched, setTotalMatched] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  // Autofocus on mount. Esc closes — handled here so the input has focus
  // priority and a single keypress dismisses the bar.
  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      // A deeper modal layer (e.g. the MediaLightbox opened on top of search)
      // owns the Escape and marks it handled — don't also close the search bar
      // and wipe the agent's active query/match position.
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Debounced fetch. reqId guards out-of-order responses so a slow page-1
  // can't stomp a fresher request.
  useEffect(() => {
    onQueryChange(query);
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      onMatchesChange([]);
      setTotalMatched(0);
      setLoading(false);
      setError(null);
      return;
    }
    const my = ++reqId.current;
    setLoading(true);
    setError(null);
    const t = window.setTimeout(async () => {
      try {
        // Load ALL matches by following the cursor (up to a cap) so ↑/↓ can
        // reach every match and the count is accurate. The old single take=100
        // capped BOTH navigation and the displayed total at 100 — a common word
        // in a long thread showed "1 of 100" and couldn't reach older matches.
        const MAX_MATCHES = 300;
        const all: SearchHit[] = [];
        let cursor: string | null = null;
        let total = 0;
        do {
          const res = await apiFetch(
            `/api/conversations/${conversationId}/messages/search?q=${encodeURIComponent(
              trimmed,
            )}&take=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          );
          if (reqId.current !== my) return;
          if (!res.ok) {
            setError("Search failed");
            onMatchesChange([]);
            return;
          }
          const data = (await res.json()) as SearchPage;
          if (reqId.current !== my) return;
          all.push(...data.items);
          total = data.totalMatched;
          cursor = data.nextCursor;
        } while (cursor && all.length < MAX_MATCHES);
        if (reqId.current !== my) return;
        setTotalMatched(total);
        onMatchesChange(all);
      } catch {
        if (reqId.current === my) {
          setError("Network error");
          onMatchesChange([]);
        }
      } finally {
        if (reqId.current === my) setLoading(false);
      }
    }, 200);
    return () => window.clearTimeout(t);
    // onQueryChange + onMatchesChange are stable callbacks; the linter
    // can't tell, so we omit them from the deps to avoid a refetch loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, conversationId]);

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;
  // 1-based for display ("3 / 17"); 0-based internally.
  const human = totalMatches > 0 ? activeIndex + 1 : 0;
  const canNav = totalMatches > 1;
  // Show the server's true total (loaded matches === total below the cap; above
  // it the count still reads accurately while nav covers the loaded set).
  const displayTotal = totalMatched || totalMatches;

  function nav(direction: -1 | 1) {
    if (!canNav) return;
    // Wrap around like WhatsApp — pressing past the end loops back.
    const next = (activeIndex + direction + totalMatches) % totalMatches;
    onActiveIndexChange(next);
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 py-2 backdrop-blur">
      <div className="relative flex-1">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // Shift+Enter goes to the previous (newer) match, plain
              // Enter goes to the next (older). Matches WhatsApp where
              // Enter steps "down through history."
              nav(e.shiftKey ? -1 : 1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              nav(1); // older
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              nav(-1); // newer
            }
          }}
          placeholder="Search messages…"
          aria-label="Search messages in this conversation"
          className="h-8 pl-8 pr-9 text-sm"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 text-2xs tabular-nums">
        {loading ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Searching…
          </span>
        ) : error ? (
          <span className="text-destructive">{error}</span>
        ) : hasQuery ? (
          <span
            className={cn(
              "text-muted-foreground",
              totalMatches === 0 && "text-destructive",
            )}
          >
            {totalMatches === 0
              ? "No matches"
              : `${human} of ${displayTotal}`}
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={() => nav(1)}
          disabled={!canNav}
          aria-label="Older match"
          title="Older match (↑ or Enter)"
          className="inline-flex size-7 pointer-coarse:size-9 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronUp className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => nav(-1)}
          disabled={!canNav}
          aria-label="Newer match"
          title="Newer match (↓ or Shift+Enter)"
          className="inline-flex size-7 pointer-coarse:size-9 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>

      <button
        type="button"
        onClick={onClose}
        aria-label="Close search"
        className="ml-1 inline-flex size-7 pointer-coarse:size-9 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * Used by MessageBubble to highlight matched substrings inside a body.
 * Escapes regex metacharacters so a hostile query like `[ab]` matches the
 * literal four-character string, not a character class.
 *
 * Exported here so MessageBubble can call it without re-implementing.
 */
export function highlightQuery(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "ig");
  const parts = text.split(re);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark
        key={i}
        // Unified token-based highlight — the SAME treatment the global
        // inbox-search panel uses (inbox-search-panel.tsx `highlight`), so a
        // match reads identically whether it's surfaced in the search list or
        // highlighted in place inside a chat bubble.
        className="rounded-[2px] bg-primary/20 px-0.5 text-foreground"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
