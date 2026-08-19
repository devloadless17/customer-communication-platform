"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Search as SearchIcon, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { apiErrorMessage, NETWORK_ERROR_MESSAGE } from "@ccp/shared/api/error-message";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { initials } from "@ccp/shared/utils";
import type { TeamChannelMessageDto } from "@ccp/shared/team-chat/types";

const DEBOUNCE_MS = 250;
const RESULT_BODY_EXCERPT = 200;

/**
 * Channel-scoped message search. Renders as a slim panel below the channel
 * header, mirroring the inbox's in-thread search pattern.
 *
 * Flow:
 *   1. Type → debounced GET /api/team-chat/channels/:id/messages/search?q=…
 *   2. Render the result list (newest-first).
 *   3. Click a result → `onJumpTo(messageId)`. The workspace scrolls to it
 *      via `[data-message-id]` when it's in the loaded slice, and otherwise
 *      fetches a context window around it (`/messages/around` via
 *      `loadAround`) and enters anchored mode — see `jumpToMessage` in
 *      team-chat-workspace.tsx.
 *
 * Owns: input state, debounce, fetch, render. Does NOT own scroll behavior
 * — that lives one level up so it can integrate with useChatScroll.
 */
export function ChannelSearch({
  channelId,
  onClose,
  onJumpTo,
  onQueryChange,
}: {
  channelId: string;
  onClose: () => void;
  /** Caller is responsible for scrolling — see comment in this file's header. */
  onJumpTo: (messageId: string) => void;
  /** Notify the workspace of the live query so chat bubbles can highlight
   *  inline matches with `<mark>` (same WhatsApp pattern the inbox uses).
   *  Fires on every keystroke before the debounce — bubble highlight is
   *  cheap and immediate feels right. */
  onQueryChange?: (query: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TeamChannelMessageDto[] | null>(null);
  // A failed search is not an empty one: reporting "No matches." for a request
  // that never answered tells someone their message isn't there when it is.
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Tell the parent what to highlight inside chat bubbles.
  useEffect(() => {
    onQueryChange?.(query);
  }, [query, onQueryChange]);

  // Autofocus on open so the user can type immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await fetchWithSessionGuard(
          `/api/team-chat/channels/${channelId}/messages/search?q=${encodeURIComponent(q)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setResults(null);
          setError(await apiErrorMessage(res, "Search didn't run."));
          return;
        }
        const page = (await res.json()) as {
          items: TeamChannelMessageDto[];
          nextCursor: string | null;
        };
        if (!cancelled) {
          setResults(page.items);
          setError(null);
        }
      } catch {
        // fetchWithSessionGuard THROWS on a network failure (and on a 401, which
        // it handles by bouncing) — unguarded, that left the spinner spinning.
        if (!cancelled) {
          setResults(null);
          setError(NETWORK_ERROR_MESSAGE);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [channelId, query]);

  return (
    <div className="shrink-0 border-b border-border bg-background">
      <div className="flex items-center gap-2 px-4 py-2">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Search this channel"
          aria-label="Search this channel"
          className="h-8 flex-1 text-sm"
        />
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close search"
          className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:size-9"
        >
          <X className="size-4" />
        </button>
      </div>

      {error && (
        <div className="border-t border-border px-4 py-6 text-center text-xs text-destructive">
          {error}
        </div>
      )}

      {results !== null && (
        <div className="max-h-72 overflow-y-auto border-t border-border">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-xs text-muted-foreground">
              No matches.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {results.map((m) => (
                <SearchResultRow
                  key={m.id}
                  message={m}
                  query={query.trim()}
                  onSelect={() => {
                    onJumpTo(m.id);
                    onClose();
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SearchResultRow({
  message,
  query,
  onSelect,
}: {
  message: TeamChannelMessageDto;
  query: string;
  onSelect: () => void;
}) {
  const body = message.body ?? "";
  // Center the excerpt around the first match so context is visible on both
  // sides of the highlight, instead of always slicing from index 0.
  const matchAt = body.toLowerCase().indexOf(query.toLowerCase());
  const start = matchAt > 60 ? matchAt - 60 : 0;
  const sliced = body.slice(start, start + RESULT_BODY_EXCERPT);
  const excerpt = start > 0 ? `…${sliced}` : sliced;

  const date = new Date(message.createdAt);
  const stamp = date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-accent/40"
      >
        <span
          className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground"
          aria-hidden
        >
          {initials(message.authorName ?? "?")}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[12.5px] font-medium">
              {message.authorName ?? "Removed user"}
            </span>
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
              {stamp}
            </span>
          </span>
          <span className="mt-0.5 block text-[12.5px] text-foreground/80">
            <HighlightedExcerpt text={excerpt} query={query} />
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * Renders `text` with case-insensitive occurrences of `query` wrapped in a
 * highlight span. Plain string slicing — no regex — so user input with regex
 * metacharacters doesn't ReDoS or escape into the matcher.
 */
function HighlightedExcerpt({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(q, cursor);
    if (idx === -1) {
      parts.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (idx > cursor) {
      parts.push({ text: text.slice(cursor, idx), match: false });
    }
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    cursor = idx + q.length;
  }
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded bg-yellow-200/70 px-0.5 text-foreground dark:bg-yellow-500/30">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}
