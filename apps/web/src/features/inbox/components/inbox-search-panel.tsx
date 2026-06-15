"use client";

import { useEffect, useRef, useState } from "react";
import {
  Loader2,
  MessageSquare,
  Phone,
  SearchX,
  StickyNote,
  Users,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { EmptyState as EmptyStateCard } from "@/components/ui/empty-state";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LocalTime } from "@/components/local-time";
import { avatarGradient } from "@ccp/shared/utils/avatar-color";
import { cn, initials } from "@ccp/shared/utils";
import type {
  ContactSearchHit,
  GlobalMessageHit,
  InboxSearchScope,
  NoteSearchHit,
} from "@ccp/shared/dtos";

import { useInboxSearch } from "../hooks/use-inbox-search";

/** Where a search hit sends the agent. `messageId` jumps the thread to a
 *  specific message; omitted for contacts/notes (just open the thread). */
export interface SearchResultTarget {
  conversationId: string;
  messageId?: string;
}

const TABS: { id: InboxSearchScope; label: string; icon: typeof Users }[] = [
  { id: "contacts", label: "Contacts", icon: Users },
  { id: "messages", label: "Messages", icon: MessageSquare },
  { id: "notes", label: "Comments", icon: StickyNote },
];

/**
 * Tabbed global inbox search. Replaces the old client-side filter: the search
 * box now searches the WHOLE team's data across three scopes, each on its own
 * tab with independent results + pagination. Rendered in place of the live
 * conversation list whenever the search box has a query.
 *
 * One {@link useInboxSearch} per scope so switching tabs is instant (results
 * are already in memory) and the shared query string drives all three. Only
 * the active tab's results are shown, but all three fetch on type so the tab
 * counts/results are warm the moment the agent switches.
 */
export function InboxSearchPanel({
  query,
  onOpenResult,
  onStartContactChat,
}: {
  query: string;
  /** Open a conversation, optionally jumping to a specific message. */
  onOpenResult: (target: SearchResultTarget) => void;
  /** A contact with no conversation yet — kick off a fresh chat. */
  onStartContactChat: (contactId: string) => void;
}) {
  const [scope, setScope] = useState<InboxSearchScope>("contacts");

  const contacts = useInboxSearch("contacts", query);
  const messages = useInboxSearch("messages", query);
  const notes = useInboxSearch("notes", query);

  const current =
    scope === "contacts" ? contacts : scope === "messages" ? messages : notes;

  // Infinite scroll: observe a sentinel at the list bottom.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef(current.loadMore);
  loadMoreRef.current = current.loadMore;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMoreRef.current();
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [scope]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Scope tabs */}
      <div
        role="tablist"
        aria-label="Search scope"
        className="flex items-center gap-1 border-b border-border px-3 pb-2"
      >
        {TABS.map((t) => {
          const isActive = t.id === scope;
          const Icon = t.icon;
          const state =
            t.id === "contacts"
              ? contacts
              : t.id === "messages"
                ? messages
                : notes;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={isActive}
              type="button"
              onClick={() => setScope(t.id)}
              className={cn(
                "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {t.label}
              {state.loading && (
                <Loader2 className="size-3 animate-spin opacity-70" />
              )}
            </button>
          );
        })}
      </div>

      <ScrollArea className="flex-1">
        <div className="px-1.5 py-2">
          {current.loading && current.results.length === 0 ? (
            <EmptyState text="Searching…" spinner />
          ) : current.results.length === 0 ? (
            <EmptyStateCard
              icon={SearchX}
              title="No results"
              description={`No ${scope} match “${query.trim()}”.`}
              className="m-2 border-0 bg-transparent py-12"
            />
          ) : (
            <ul className="flex flex-col gap-0.5">
              {scope === "contacts" &&
                contacts.results.map((hit) => (
                  <ContactRow
                    key={hit.contactId}
                    hit={hit}
                    query={query}
                    onOpen={() =>
                      hit.conversationId
                        ? onOpenResult({ conversationId: hit.conversationId })
                        : onStartContactChat(hit.contactId)
                    }
                  />
                ))}
              {scope === "messages" &&
                messages.results.map((hit) => (
                  <MessageRow
                    key={hit.messageId}
                    hit={hit}
                    query={query}
                    onOpen={() =>
                      onOpenResult({
                        conversationId: hit.conversationId,
                        messageId: hit.messageId,
                      })
                    }
                  />
                ))}
              {scope === "notes" &&
                notes.results.map((hit) => (
                  <NoteRow
                    key={hit.noteId}
                    hit={hit}
                    query={query}
                    onOpen={() =>
                      onOpenResult({ conversationId: hit.conversationId })
                    }
                  />
                ))}
            </ul>
          )}

          {/* Infinite-scroll sentinel + load-more affordance */}
          {current.nextCursor && (
            <div
              ref={sentinelRef}
              className="flex items-center justify-center py-3 text-2xs text-muted-foreground"
            >
              {current.loadingMore ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" />
                  Loading more…
                </span>
              ) : (
                <span>Scroll for more</span>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function EmptyState({ text, spinner }: { text: string; spinner?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-12 text-center text-xs text-muted-foreground">
      {spinner && <Loader2 className="size-4 animate-spin" />}
      <span>{text}</span>
    </div>
  );
}

// ---- Rows -----------------------------------------------------------------

function HitAvatar({ name, url }: { name: string; url?: string }) {
  return (
    <Avatar className="size-9 shrink-0">
      {url ? <AvatarImage src={url} alt="" /> : null}
      <AvatarFallback
        className="text-2xs font-medium text-white"
        style={{ background: avatarGradient(name) }}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** Wraps the matched substring in a subtle accent mark. Escapes regex meta so
 *  a query like `a.b` matches literally. Uses the same token-based highlight
 *  treatment as the in-thread search (message-search.tsx `highlightQuery`) so
 *  matches read identically across the global panel and the chat bubbles. */
function highlight(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark
        key={i}
        className="rounded-[2px] bg-primary/20 px-0.5 text-foreground"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

const rowBase =
  "flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/60";

function ContactRow({
  hit,
  query,
  onOpen,
}: {
  hit: ContactSearchHit;
  query: string;
  onOpen: () => void;
}) {
  // Secondary line: show the matched field's value (so an email/phone match
  // reads sensibly), falling back to phone.
  const secondary =
    hit.matchedField === "name" ? hit.phoneNumber ?? "" : hit.matchedValue;
  return (
    <li>
      <button type="button" onClick={onOpen} className={rowBase}>
        <HitAvatar name={hit.name} url={hit.avatarUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {highlight(hit.name, query)}
            </span>
            {!hit.conversationId && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-3xs text-muted-foreground">
                no chat
              </span>
            )}
          </div>
          {secondary && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              {hit.matchedField === "phone" && (
                <Phone className="size-3 shrink-0" />
              )}
              <span className="min-w-0 truncate">{highlight(secondary, query)}</span>
            </div>
          )}
        </div>
      </button>
    </li>
  );
}

function MessageRow({
  hit,
  query,
  onOpen,
}: {
  hit: GlobalMessageHit;
  query: string;
  onOpen: () => void;
}) {
  return (
    <li>
      <button type="button" onClick={onOpen} className={rowBase}>
        <HitAvatar name={hit.contactName} url={hit.contactAvatarUrl} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium">
              {hit.contactName}
            </span>
            <LocalTime
              iso={hit.timestamp}
              format="listTime"
              className="shrink-0 text-3xs text-muted-foreground"
            />
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {hit.direction === "out" && (
              <span className="text-muted-foreground/70">You: </span>
            )}
            {hit.mediaKind && (
              <span className="text-muted-foreground/70">
                [{hit.mediaKind}]{" "}
              </span>
            )}
            {highlight(hit.snippet, query)}
          </div>
        </div>
      </button>
    </li>
  );
}

function NoteRow({
  hit,
  query,
  onOpen,
}: {
  hit: NoteSearchHit;
  query: string;
  onOpen: () => void;
}) {
  return (
    <li>
      <button type="button" onClick={onOpen} className={rowBase}>
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
          <StickyNote className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-medium">
              {hit.contactName}
            </span>
            <LocalTime
              iso={hit.timestamp}
              format="listTime"
              className="shrink-0 text-3xs text-muted-foreground"
            />
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {highlight(hit.snippet, query)}
          </div>
          <div className="mt-0.5 truncate text-3xs text-muted-foreground/70">
            — {hit.authorName ?? "Removed user"}
          </div>
        </div>
      </button>
    </li>
  );
}
