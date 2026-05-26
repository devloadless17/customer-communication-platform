"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type { Filter, PresetFilterId } from "@/features/inbox/components/inbox-controls";

/**
 * The active inbox filter (All / Mine / Unassigned / Closed preset, or a
 * per-stage filter) shared between the inbox sub-sidebar and the conversation
 * list.
 *
 * Why a context: post the layout split, the sub-sidebar renders at the
 * `/inbox` LAYOUT level (so it paints instantly and survives the page's
 * loading skeleton) while the conversation list stays in the page island
 * (`InboxShell`). Both need to read + write the same filter. The provider
 * lives in the layout and wraps both the sub-sidebar slot AND the page
 * (`children`), so a single source of truth crosses the layout/page boundary
 * without lifting it into the URL (which would re-run the server page on every
 * filter click and fight the inbox's `history.pushState`-based chat switching).
 *
 * Persistence: the selected filter is mirrored to a cookie so a hard refresh
 * keeps you on the same view. The layout reads the cookie SSR-side and seeds
 * the provider via `initialFilter`, so the seed paints correct from the very
 * first frame (no flash from "All open" → "Stage 2"). A `?` after stage
 * deletion / id-mismatch case is handled by the layout, which validates the
 * persisted stage id against the live `stages` list before forwarding it.
 */
const COOKIE_NAME = "inbox-filter";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

const VALID_PRESETS: ReadonlySet<PresetFilterId> = new Set([
  "all",
  "mine",
  "unassigned",
  "closed",
]);

const DEFAULT_FILTER: Filter = { kind: "preset", id: "all" };

interface InboxFilterContextValue {
  filter: Filter;
  setFilter: (next: Filter) => void;
}

const InboxFilterContext = createContext<InboxFilterContextValue | null>(null);

/**
 * Serialize a filter into the short cookie value:
 *   - `p:<presetId>` for presets
 *   - `s:<stageId>`  for stage filters
 * Kept small (<80 bytes) so the cookie travels with every request without
 * inflating headers. Stage ids are cuids (~25 chars), so even with a
 * one-byte prefix the cookie stays compact.
 */
export function serializeInboxFilter(filter: Filter): string {
  if (filter.kind === "preset") return `p:${filter.id}`;
  return `s:${filter.stageId}`;
}

/**
 * Parse the cookie back to a `Filter`. Returns null when the cookie is
 * missing or malformed — callers fall back to the default. The layout
 * additionally validates a returned stage id against its loaded `stages`
 * list and ignores stale ids (deleted stage on another tab / device).
 */
export function parseInboxFilter(raw: string | undefined): Filter | null {
  if (!raw) return null;
  if (raw.startsWith("p:")) {
    const id = raw.slice(2);
    if (VALID_PRESETS.has(id as PresetFilterId)) {
      return { kind: "preset", id: id as PresetFilterId };
    }
    return null;
  }
  if (raw.startsWith("s:")) {
    const stageId = raw.slice(2);
    if (stageId.length > 0) return { kind: "stage", stageId };
    return null;
  }
  return null;
}

export const INBOX_FILTER_COOKIE = COOKIE_NAME;

export function InboxFilterProvider({
  children,
  initialFilter,
}: {
  children: ReactNode;
  /** SSR-seeded filter from the cookie. Defaults to "All open" when absent
   *  or when the persisted stage id no longer matches a live stage. */
  initialFilter?: Filter;
}) {
  const [filter, setFilterState] = useState<Filter>(initialFilter ?? DEFAULT_FILTER);

  const setFilter = useCallback((next: Filter) => {
    setFilterState(next);
    // Cookie write keeps the persistence in lockstep with the React state.
    // SameSite=Lax — the cookie is read only by our own server during SSR;
    // cross-site requests don't need it. `Secure` is appended in prod (HTTPS)
    // as a hardening hygiene; dropped on http://localhost so dev still works.
    // Browsers reject `Secure` on http:// URLs silently, which would lose
    // persistence in dev without the conditional.
    const secureFlag =
      typeof window !== "undefined" && window.location.protocol === "https:"
        ? "; secure"
        : "";
    document.cookie = `${COOKIE_NAME}=${serializeInboxFilter(next)}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax${secureFlag}`;
  }, []);

  const value = useMemo(() => ({ filter, setFilter }), [filter, setFilter]);
  return (
    <InboxFilterContext.Provider value={value}>
      {children}
    </InboxFilterContext.Provider>
  );
}

/**
 * Read the shared inbox filter. Throws outside the provider so a missing
 * `/inbox/layout.tsx` mount surfaces loudly instead of silently desyncing the
 * sub-sidebar from the conversation list.
 */
export function useInboxFilter(): InboxFilterContextValue {
  const value = useContext(InboxFilterContext);
  if (!value) {
    throw new Error("useInboxFilter must be used within an InboxFilterProvider");
  }
  return value;
}
