"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import type { Filter } from "@/features/inbox/components/inbox-controls";

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
 */
interface InboxFilterContextValue {
  filter: Filter;
  setFilter: (next: Filter) => void;
}

const InboxFilterContext = createContext<InboxFilterContextValue | null>(null);

export function InboxFilterProvider({ children }: { children: ReactNode }) {
  const [filter, setFilter] = useState<Filter>({ kind: "preset", id: "all" });
  const value = useMemo(() => ({ filter, setFilter }), [filter]);
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
