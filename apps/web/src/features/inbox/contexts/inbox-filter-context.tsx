"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type { Filter } from "@/features/inbox/components/inbox-controls";
import {
  INBOX_FILTER_COOKIE,
  INBOX_FILTER_COOKIE_MAX_AGE_S,
  INBOX_FILTER_DEFAULT,
  serializeInboxFilter,
} from "@/features/inbox/contexts/inbox-filter";

// Re-export pure primitives so existing server-component imports (e.g. the
// inbox layout) keep working through this file. The actual definitions live
// in the non-"use client" sibling — moved 2026-05-26 after a Playwright
// pre-deploy smoke caught `Attempted to call parseInboxFilter() from the
// server but parseInboxFilter is on the client` (the previous version had
// the parser + COOKIE constants colocated under the `"use client"` directive
// at the top of this file, which prevents server components from importing
// them at runtime even though they're pure functions).
export {
  INBOX_FILTER_COOKIE,
  parseInboxFilter,
  serializeInboxFilter,
} from "@/features/inbox/contexts/inbox-filter";

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

interface InboxFilterContextValue {
  filter: Filter;
  setFilter: (next: Filter) => void;
}

const InboxFilterContext = createContext<InboxFilterContextValue | null>(null);

export function InboxFilterProvider({
  children,
  initialFilter,
}: {
  children: ReactNode;
  /** SSR-seeded filter from the cookie. Defaults to "All open" when absent
   *  or when the persisted stage id no longer matches a live stage. */
  initialFilter?: Filter;
}) {
  const [filter, setFilterState] = useState<Filter>(initialFilter ?? INBOX_FILTER_DEFAULT);

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
    document.cookie = `${INBOX_FILTER_COOKIE}=${serializeInboxFilter(next)}; path=/; max-age=${INBOX_FILTER_COOKIE_MAX_AGE_S}; samesite=lax${secureFlag}`;
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
