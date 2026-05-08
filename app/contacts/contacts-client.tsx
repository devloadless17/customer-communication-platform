"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Loader2, MessageSquare, Plus, Search, Upload, X } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WindowBadge } from "@/components/inbox/window-badge";
import { avatarGradient } from "@/lib/avatar-color";
import { formatListTime, formatPhone, initials } from "@/lib/utils";
import type {
  ContactFieldDefinition,
  ContactListItem,
  ContactSource,
  CursorPage,
} from "@/lib/types";

import { ImportContactsDialog } from "./import-dialog";
import { NewContactDialog } from "./new-contact-dialog";

type SourceFilter = "all" | ContactSource;

interface FieldFilter {
  key: string;
  value: string;
}

/**
 * Contacts directory.
 *
 * Server seeds the first page; client takes over for search, filter, and
 * pagination. The list refetches whenever search/filter changes (debounced
 * 250ms) — the dataset is small enough today that we don't need to be
 * cleverer than this.
 */
export function ContactsClient({
  initialItems,
  initialNextCursor,
  fieldDefinitions: initialFieldDefinitions,
  canManageFields,
}: {
  initialItems: ContactListItem[];
  initialNextCursor: string | null;
  fieldDefinitions: ContactFieldDefinition[];
  canManageFields: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState<ContactListItem[]>(initialItems);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  // Lifted to state so dialogs can splice in newly-created definitions
  // without waiting on a router.refresh round trip.
  const [fieldDefinitions, setFieldDefinitions] =
    useState<ContactFieldDefinition[]>(initialFieldDefinitions);
  const [search, setSearch] = useState("");
  const [fieldFilter, setFieldFilter] = useState<FieldFilter | null>(null);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  // Refetch on search/filter change. Debounce server hits so typing doesn't
  // flood the API; abort in-flight on the next change so a slow page-1 can't
  // overwrite a faster page-2.
  const reqId = useRef(0);
  useEffect(() => {
    const my = ++reqId.current;
    setLoading(true);
    setError(null);
    const t = window.setTimeout(async () => {
      try {
        const page = await fetchPage({ search, fieldFilter, sourceFilter, cursor: null });
        if (reqId.current !== my) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      } catch {
        if (reqId.current === my) setError("Couldn't load contacts");
      } finally {
        if (reqId.current === my) setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [search, fieldFilter, sourceFilter]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage({ search, fieldFilter, sourceFilter, cursor: nextCursor });
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch {
      setError("Couldn't load more");
    } finally {
      setLoadingMore(false);
    }
  }

  // The search is broad enough — also matches inside customFields JSON — that
  // we don't need a "no results" hint per filter dimension. Just empty state.
  const showEmpty = !loading && items.length === 0;

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Contacts</h1>
          <p className="text-sm text-muted-foreground">
            People who messaged your team, plus anyone you add manually.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            {/* Plain anchor: lets the browser handle Content-Disposition and
                save the file directly without a fetch + Blob round-trip. */}
            <a href="/api/contacts/export" download>
              <Download className="size-4" />
              Export
            </a>
          </Button>
          <Button variant="outline" onClick={() => setImporting(true)}>
            <Upload className="size-4" />
            Import
          </Button>
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            New contact
          </Button>
        </div>
      </header>

      <div className="mb-3 flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">Show:</span>
        <SourceChip
          active={sourceFilter === "all"}
          onClick={() => setSourceFilter("all")}
          label="All"
        />
        <SourceChip
          active={sourceFilter === "inbound"}
          onClick={() => setSourceFilter("inbound")}
          label="Messaged me"
        />
        <SourceChip
          active={sourceFilter === "manual"}
          onClick={() => setSourceFilter("manual")}
          label="Added by me"
        />
      </div>

      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone, email, or any field…"
            className="pl-8"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      {fieldDefinitions.length > 0 && (
        <FieldFilterRow
          fieldDefinitions={fieldDefinitions}
          value={fieldFilter}
          onChange={setFieldFilter}
        />
      )}

      {error && (
        <div className="mb-3 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card">
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading…
          </div>
        ) : showEmpty ? (
          <div className="px-6 py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {search || fieldFilter
                ? "No contacts match your filters."
                : "No contacts yet. Click \"New contact\" to add one."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <ContactRow
                key={item.contact.id}
                item={item}
                fieldDefinitions={fieldDefinitions}
              />
            ))}
          </ul>
        )}
        {nextCursor && (
          <div className="border-t border-border p-3 text-center">
            <Button variant="ghost" size="sm" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading…
                </>
              ) : (
                "Load more"
              )}
            </Button>
          </div>
        )}
      </div>

      {importing && (
        <ImportContactsDialog
          onClose={() => setImporting(false)}
          onImported={() => {
            setImporting(false);
            // Hard refresh — import might have added many rows; refetching
            // the page is simpler than splicing into local state.
            router.refresh();
          }}
        />
      )}

      {creating && (
        <NewContactDialog
          fieldDefinitions={fieldDefinitions}
          canManageFields={canManageFields}
          onClose={() => setCreating(false)}
          onCreated={(item) => {
            // Splice to top so the new contact is visible without a refetch.
            // The server-side sort puts contacts with no messages by createdAt,
            // and this one was just created, so this matches the canonical
            // order. router.refresh() also pulls a fresh server render in the
            // background.
            setItems((prev) => [item, ...prev]);
            setCreating(false);
            router.refresh();
          }}
          onTeamWideFieldAdded={(def) => {
            setFieldDefinitions((prev) =>
              // Server enforces unique keys; defensive dedupe in case the
              // server-rendered list already had it (e.g. created in another
              // tab).
              prev.some((d) => d.id === def.id)
                ? prev
                : [...prev, def].sort((a, b) => a.order - b.order),
            );
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ContactRow({
  item,
  fieldDefinitions,
}: {
  item: ContactListItem;
  fieldDefinitions: ContactFieldDefinition[];
}) {
  const { contact, activeConversationId, lastMessageAt, lastInboundAt } = item;

  const filledFields = fieldDefinitions
    .map((def) => ({ def, value: contact.customFields[def.key] }))
    .filter((f): f is { def: ContactFieldDefinition; value: string } => Boolean(f.value));

  return (
    <li className="flex items-center gap-3 px-4 py-3 hover:bg-accent/40">
      <Avatar className="size-9 shrink-0">
        <AvatarFallback
          className="text-sm text-white"
          style={{ backgroundImage: avatarGradient(contact.id) }}
        >
          {initials(contact.name)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{contact.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {formatPhone(contact.phoneNumber)}
          </span>
          <SourceBadge source={contact.source} />
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          {contact.email && <span className="truncate">{contact.email}</span>}
          {contact.email && contact.location && <span>·</span>}
          {contact.location && <span className="truncate">{contact.location}</span>}
        </div>
        {filledFields.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {filledFields.map(({ def, value }) => (
              <Badge key={def.id} variant="muted" className="text-[10px]">
                <span className="opacity-60">{def.label}:</span>
                <span className="ml-1">{value}</span>
              </Badge>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
        <WindowBadge lastInboundAt={lastInboundAt} size="xs" className="hidden md:inline-flex" />
        {lastMessageAt && (
          <span className="hidden tabular-nums lg:inline">
            {formatListTime(lastMessageAt)}
          </span>
        )}
        {activeConversationId ? (
          <Link
            href={`/inbox/${activeConversationId}`}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent hover:text-foreground"
          >
            <MessageSquare className="size-3" />
            Open chat
          </Link>
        ) : (
          <span className="rounded-md border border-dashed border-border px-2.5 py-1 text-xs">
            No thread yet
          </span>
        )}
      </div>
    </li>
  );
}

function FieldFilterRow({
  fieldDefinitions,
  value,
  onChange,
}: {
  fieldDefinitions: ContactFieldDefinition[];
  value: FieldFilter | null;
  onChange: (next: FieldFilter | null) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function startEditing(key: string) {
    setOpenKey(key);
    setDraft(value?.key === key ? value.value : "");
  }

  function commit() {
    if (!openKey) return;
    const trimmed = draft.trim();
    if (!trimmed) {
      onChange(null);
    } else {
      onChange({ key: openKey, value: trimmed });
    }
    setOpenKey(null);
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Filter:</span>
      {fieldDefinitions.map((def) => {
        const active = value?.key === def.key;
        if (openKey === def.key) {
          return (
            <div key={def.id} className="flex items-center gap-1">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setOpenKey(null);
                  }
                }}
                placeholder={`${def.label} contains…`}
                autoFocus
                className="h-7 w-44 text-xs"
              />
            </div>
          );
        }
        return (
          <button
            key={def.id}
            type="button"
            onClick={() => startEditing(def.key)}
            className={`flex items-center gap-1 rounded-full border px-2 py-0.5 transition ${
              active
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-accent"
            }`}
          >
            <span>{def.label}</span>
            {active && <span className="font-medium text-foreground">: {value?.value}</span>}
            {active && (
              <X
                className="size-3"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

async function fetchPage(opts: {
  search: string;
  fieldFilter: FieldFilter | null;
  sourceFilter: SourceFilter;
  cursor: string | null;
}): Promise<CursorPage<ContactListItem>> {
  const params = new URLSearchParams();
  if (opts.search.trim()) params.set("search", opts.search.trim());
  if (opts.fieldFilter) {
    params.set("fieldKey", opts.fieldFilter.key);
    params.set("fieldValue", opts.fieldFilter.value);
  }
  if (opts.sourceFilter !== "all") params.set("source", opts.sourceFilter);
  if (opts.cursor) params.set("cursor", opts.cursor);
  const res = await fetch(`/api/contacts?${params.toString()}`);
  if (!res.ok) throw new Error("fetch failed");
  return (await res.json()) as CursorPage<ContactListItem>;
}

function SourceBadge({ source }: { source: ContactSource }) {
  if (source === "manual") {
    return (
      <Badge variant="muted" className="text-[10px]">
        Added by you
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="text-[10px]">
      Messaged you
    </Badge>
  );
}

function SourceChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 transition ${
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent"
      }`}
    >
      {label}
    </button>
  );
}
