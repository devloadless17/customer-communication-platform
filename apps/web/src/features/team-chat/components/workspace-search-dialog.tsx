"use client";

import { useEffect, useRef, useState } from "react";

import { useRouter } from "next/navigation";
import { Hash, Loader2, Search as SearchIcon, X } from "lucide-react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { initials } from "@ccp/shared/utils";
import type { WorkspaceSearchHit } from "@ccp/shared/team-chat/types";

const DEBOUNCE_MS = 250;
const RESULT_EXCERPT_LEN = 200;

/**
 * Cmd+K-style overlay for workspace-wide search across every channel.
 *
 * Built on the same ModalShell pattern as `channel-dialogs.tsx` (plain
 * fixed-overlay div, no Radix dependency) — keeps the team-chat surface
 * dep-isolated and matches existing visual style.
 *
 * Click-through behavior:
 *   - Selecting a result navigates to `/team/<channelId>?jumpTo=<id>&q=…`.
 *   - The destination workspace reads `?jumpTo` on mount and calls
 *     `loadAround(messageId)` to fetch the context window + scroll to it.
 *     `?q` keeps inline-highlight active at the destination so the user
 *     can see WHY this message was a match.
 *
 * Owns the input + debounced fetch. Knows nothing about scrolling — that's
 * the receiving workspace's job, hence the URL-as-message-passing pattern.
 */
export function WorkspaceSearchDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset on open so a fresh visit doesn't show stale results, and autofocus
  // a frame later so the modal mount completes first.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults(null);
    const t = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await fetchWithSessionGuard(
          `/api/team/channels/search?q=${encodeURIComponent(q)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setResults([]);
          return;
        }
        const page = (await res.json()) as {
          items: WorkspaceSearchHit[];
          nextCursor: string | null;
        };
        if (!cancelled) setResults(page.items);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, query]);

  if (!open) return null;

  const onSelect = (hit: WorkspaceSearchHit) => {
    onClose();
    const params = new URLSearchParams({
      jumpTo: hit.message.id,
      q: query.trim(),
      // Nonce. The destination strips `jumpTo`/`q` with `history.replaceState`
      // (deliberately — a `router.replace` would re-run the RSC page), which
      // the App Router never learns about. So pushing the SAME jump URL a
      // second time was a no-op navigation: the banner appeared but the feed
      // never moved. A per-click value keeps every jump a distinct URL.
      n: String(hit.message.id.length + Math.floor(performance.now())),
    });
    router.push(`/team/${hit.message.channelId}?${params.toString()}`);
  };

  return (
    // Command-palette positioning — sit in the upper third (`items-start
    // pt-[15vh]`) rather than vertically centered, overriding the canonical
    // scrim's `items-center`. Chrome (scrim + card) is otherwise canonical.
    <Dialog open={open} onClose={onClose} overlayClassName="items-start pt-[15vh]">
      <DialogContent
        ariaLabel="Search team chat"
        className="max-w-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages across every channel"
            aria-label="Search team chat"
            className="h-9 flex-1 border-0 text-[15px] focus-visible:ring-0"
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

        <div className="max-h-[60vh] overflow-y-auto">
          {results === null ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              {query.trim().length === 0
                ? "Type to search."
                : "Type at least 2 characters."}
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              No matches.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {results.map((hit) => (
                <ResultRow
                  key={hit.message.id}
                  hit={hit}
                  query={query.trim()}
                  onSelect={() => onSelect(hit)}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResultRow({
  hit,
  query,
  onSelect,
}: {
  hit: WorkspaceSearchHit;
  query: string;
  onSelect: () => void;
}) {
  const body = hit.message.body ?? "";
  // Centre the excerpt around the first match — same trick as the per-channel
  // search popover (channel-search.tsx) for consistent UX.
  const matchAt = body.toLowerCase().indexOf(query.toLowerCase());
  const start = matchAt > 60 ? matchAt - 60 : 0;
  const sliced = body.slice(start, start + RESULT_EXCERPT_LEN);
  const excerpt = start > 0 ? `…${sliced}` : sliced;

  const stamp = new Date(hit.message.createdAt).toLocaleString(undefined, {
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
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent/40"
      >
        <span
          className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
          aria-hidden
        >
          {initials(hit.message.authorName ?? "?")}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="inline-flex min-w-0 max-w-40 items-center gap-0.5 rounded-md bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
              <Hash className="size-3 shrink-0" />
              <span className="truncate">{hit.channelName}</span>
            </span>
            <span className="truncate text-sm font-medium">
              {hit.message.authorName ?? "Removed user"}
            </span>
            <span className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground">
              {stamp}
            </span>
          </span>
          <span className="mt-1 block text-sm leading-relaxed text-foreground/80">
            <HighlightedExcerpt text={excerpt} query={query} />
          </span>
        </span>
      </button>
    </li>
  );
}

/** Plain-string substring matcher — no regex, so user-supplied metacharacters
 *  can't escape into the matcher. Wraps case-insensitive matches in `<mark>`. */
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
    if (idx > cursor) parts.push({ text: text.slice(cursor, idx), match: false });
    parts.push({ text: text.slice(idx, idx + q.length), match: true });
    cursor = idx + q.length;
  }
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className="rounded bg-highlight px-0.5 text-foreground">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}
