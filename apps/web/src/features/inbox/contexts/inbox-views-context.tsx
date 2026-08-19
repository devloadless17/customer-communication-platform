"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import type {
  InboxView,
  InboxViewFilters,
} from "@ccp/shared/inbox-views/types";
import { apiFetch } from "@/lib/api/client-fetch";
import { fetchWithSessionGuard } from "@/lib/auth/client-session-guard";
import { useCoalescedAsync } from "@/features/inbox/lib/coalesce";
import { getClientSocket } from "@/lib/socket-client";
import { useSocketReconnect } from "@/hooks/use-socket-reconnect";

/**
 * Saved inbox views — the single owner of the view list, its CRUD and its
 * badge counts.
 *
 * Why a context, same reasoning as `InboxFilterProvider`: the views rail
 * renders at the `/inbox` LAYOUT level (so it paints instantly) while the
 * conversation list lives in the page island, and BOTH need the same view
 * list — the rail to draw it, the list to resolve the active view's name and
 * evaluate live rows against its criteria. Prop-drilling that across the
 * layout/page boundary isn't possible; a second fetch in each would double the
 * round-trip and let the two disagree mid-edit.
 *
 * SSR seeds `initialViews`, so the rail is correct from frame zero.
 */

export interface InboxViewCount {
  total: number;
  unread: number;
}

interface InboxViewsContextValue {
  views: InboxView[];
  /** `null` until the first counts response lands. */
  counts: Record<string, InboxViewCount> | null;
  /** Filter documents keyed by id — what `rowMatchesFilterFor` needs. */
  filtersById: Record<string, InboxViewFilters>;
  createView: (input: CreateViewInput) => Promise<InboxView | null>;
  updateView: (id: string, input: UpdateViewInput) => Promise<InboxView | null>;
  deleteView: (id: string) => Promise<boolean>;
  reorderViews: (ids: string[]) => Promise<void>;
}

export interface CreateViewInput {
  name: string;
  color?: string;
  icon?: string;
  visibility?: "personal" | "shared";
  filters: InboxViewFilters;
}

export type UpdateViewInput = Partial<CreateViewInput>;

const InboxViewsContext = createContext<InboxViewsContextValue | null>(null);

/**
 * How long to wait before refetching view counts after a count-changing socket
 * event.
 *
 * Deliberately far slower than the preset counts, which refresh immediately:
 * a preset badge is FEEDBACK on the action you just took ("I closed it — the
 * number moved"), while a saved-view badge is ambient. Debouncing here is what
 * keeps a workspace with 20 views from turning one inbound message into 40
 * COUNT queries per agent. The server's cache TTL is sized to match.
 */
const COUNTS_DEBOUNCE_MS = 2_500;

export function InboxViewsProvider({
  children,
  initialViews,
}: {
  children: ReactNode;
  initialViews: InboxView[];
}) {
  const [views, setViews] = useState<InboxView[]>(initialViews);
  const [counts, setCounts] = useState<Record<string, InboxViewCount> | null>(null);

  // Re-seed when the server sends a different list (a router.refresh() after
  // an edit in another tab). Compared by id+updatedAt rather than by
  // reference: the SSR payload is a fresh array on every render, so a
  // reference check would clobber local optimistic state constantly.
  //
  // The RESOLVED document is part of the key: deleting a stage or a teammate
  // changes what a view MATCHES without touching any view row, so `updatedAt`
  // alone would leave the live matcher evaluating against ids the server has
  // already dropped — the exact disagreement `resolvedFilters` exists to close.
  const seedKey = initialViews
    .map((v) => `${v.id}:${v.updatedAt}:${JSON.stringify(v.resolvedFilters ?? v.filters)}`)
    .join(",");
  const lastSeedKeyRef = useRef(seedKey);
  useEffect(() => {
    if (lastSeedKeyRef.current === seedKey) return;
    lastSeedKeyRef.current = seedKey;
    setViews(initialViews);
    // `initialViews` is intentionally not a dep — `seedKey` is its stable
    // content hash, and including the array would re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const refreshCounts = useCoalescedAsync(async () => {
    try {
      const res = await fetchWithSessionGuard("/api/inbox-views/counts");
      if (!res.ok) return;
      const body = (await res.json()) as { counts: Record<string, InboxViewCount> };
      setCounts(body.counts ?? {});
    } catch {
      // Silent, same convention as the preset counts: the next event
      // re-triggers, and a retry loop here would pile onto a real outage.
    }
  }, []);

  // Converge after a socket gap, exactly like the preset counts do.
  useSocketReconnect(
    () => void refreshCounts(),
    () => void refreshCounts(),
  );

  const debounceRef = useRef<number | null>(null);
  const scheduleCounts = useCallback(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void refreshCounts();
    }, COUNTS_DEBOUNCE_MS);
  }, [refreshCounts]);

  useEffect(() => {
    void refreshCounts();
    const socket = getClientSocket();
    // The same frames that can move a preset count can move a view count —
    // any of them may add or remove a row from an arbitrary filter.
    const events = [
      "message:new",
      "conversation:assigned",
      "conversation:status",
      "conversation:deleted",
      "conversation:read",
      "message:flag",
      "contact:updated",
    ] as const;
    const handler = () => scheduleCounts();
    for (const e of events) socket.on(e, handler);
    return () => {
      for (const e of events) socket.off(e, handler);
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [refreshCounts, scheduleCounts]);

  const createView = useCallback(
    async (input: CreateViewInput): Promise<InboxView | null> => {
      const res = await apiFetch("/api/inbox-views", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        // Always surface the failure. A silent `if (!res.ok) return` is the
        // exact shape that made the workspace switcher do nothing at all.
        toast.error(await errorMessage(res, "Could not save the view"));
        return null;
      }
      const { view } = (await res.json()) as { view: InboxView };
      setViews((prev) => sortViews([...prev, view]));
      void refreshCounts();
      return view;
    },
    [refreshCounts],
  );

  const updateView = useCallback(
    async (id: string, input: UpdateViewInput): Promise<InboxView | null> => {
      const res = await apiFetch(`/api/inbox-views/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        toast.error(await errorMessage(res, "Could not update the view"));
        return null;
      }
      const { view } = (await res.json()) as { view: InboxView };
      setViews((prev) => sortViews(prev.map((v) => (v.id === id ? view : v))));
      void refreshCounts();
      return view;
    },
    [refreshCounts],
  );

  const deleteView = useCallback(async (id: string): Promise<boolean> => {
    const res = await apiFetch(`/api/inbox-views/${id}`, { method: "DELETE" });
    if (!res.ok) {
      toast.error(await errorMessage(res, "Could not delete the view"));
      return false;
    }
    setViews((prev) => prev.filter((v) => v.id !== id));
    return true;
  }, []);

  const reorderViews = useCallback(async (ids: string[]) => {
    // Optimistic: reorder locally first so the drag lands instantly, then
    // reconcile with whatever the server accepted (it drops ids the caller
    // may not write).
    setViews((prev) => {
      const byId = new Map(prev.map((v) => [v.id, v]));
      const moved = ids.map((id) => byId.get(id)).filter((v): v is InboxView => !!v);
      const untouched = prev.filter((v) => !ids.includes(v.id));
      return sortViews([...moved.map((v, i) => ({ ...v, position: i })), ...untouched]);
    });
    const res = await apiFetch("/api/inbox-views/reorder", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      toast.error(await errorMessage(res, "Could not save the new order"));
      return;
    }
    const { views: next } = (await res.json()) as { views: InboxView[] };
    setViews(next);
  }, []);

  // The RESOLVED document, not the stored one: matching is evaluation, and a
  // view naming a deleted stage / teammate / option must mean here exactly what
  // it means in the server's WHERE (which runs the same resolver) — otherwise a
  // socket event splices a row out of a list a refetch immediately puts back.
  // Absent on the single-view create/update responses, whose document is
  // freshly authored against live options; fall back to it there.
  const filtersById = useMemo(
    () => Object.fromEntries(views.map((v) => [v.id, v.resolvedFilters ?? v.filters])),
    [views],
  );

  const value = useMemo(
    () => ({
      views,
      counts,
      filtersById,
      createView,
      updateView,
      deleteView,
      reorderViews,
    }),
    [views, counts, filtersById, createView, updateView, deleteView, reorderViews],
  );

  return (
    <InboxViewsContext.Provider value={value}>{children}</InboxViewsContext.Provider>
  );
}

/**
 * Read the saved views.
 *
 * Returns a stable EMPTY value outside the provider rather than throwing —
 * unlike `useInboxFilter`, this is consumed by components that also render
 * outside the inbox tree (the list header), and an inbox with no views is a
 * perfectly normal state, not a wiring bug.
 */
export function useInboxViews(): InboxViewsContextValue {
  return useContext(InboxViewsContext) ?? EMPTY_CONTEXT;
}

const EMPTY_CONTEXT: InboxViewsContextValue = {
  views: [],
  counts: null,
  filtersById: {},
  createView: async () => null,
  updateView: async () => null,
  deleteView: async () => false,
  reorderViews: async () => undefined,
};

/** Shared first, then by explicit position, then by name — mirrors the server. */
function sortViews(views: InboxView[]): InboxView[] {
  return [...views].sort((a, b) => {
    if (a.visibility !== b.visibility) return a.visibility === "shared" ? -1 : 1;
    if (a.position !== b.position) return a.position - b.position;
    return a.name.localeCompare(b.name);
  });
}

/** Turn the API's structured error into something a person can act on. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; limit?: number };
    switch (body.error) {
      case "inbox_view_name_taken":
        return "That name is already taken.";
      case "inbox_view_limit_reached":
        return `You've reached the limit of ${body.limit ?? 30} views.`;
      case "forbidden_capability":
        return "You don't have permission to manage shared views.";
      case "inbox_view_not_found":
        return "That view no longer exists.";
      default:
        return fallback;
    }
  } catch {
    return fallback;
  }
}
