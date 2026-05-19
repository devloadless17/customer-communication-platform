"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";

import { getClientSocket } from "@/lib/socket-client";

/**
 * Listens for `team:catalog:changed` and re-runs the current route's server
 * components via `router.refresh()`. Mount it once near the top of the
 * authenticated tree (currently inside InboxShell, which is the only place
 * Socket.io is used today). Every catalog change — stages, tags, contact
 * fields, automations, team members — pulls fresh data from the server
 * without any per-scope client state.
 *
 * Why a single shared handler:
 *   - The right reaction to "the X catalog moved" is always the same:
 *     invalidate the client router cache and let RSC re-fetch. Per-scope
 *     state would duplicate what the server already keeps canonical.
 *   - Mutations from settings pages and from teammates flow through the
 *     same path, so the actor doesn't need a separate router.refresh() in
 *     their save handler — they get the event too.
 *
 * Debounce window: catalog operations are usually one-at-a-time, but a
 * burst (e.g. bulk-stage rename via a future admin tool) shouldn't fan
 * out N refreshes back-to-back. We coalesce inside a 150ms window —
 * short enough to stay perceptually instant, long enough to fold any
 * multi-emit operation into a single refresh.
 */
const REFRESH_COALESCE_MS = 150;

export function useCatalogSync(): void {
  const router = useRouter();
  const pending = useRef<number | null>(null);
  // Wrap refresh in a transition so Suspense boundaries don't fall back to
  // loading.tsx during the data refetch. Without this, the FIRST mutation
  // to any catalog (e.g. creating the first tag for the team) felt like a
  // full page refresh: revalidateTag busted the data cache → router.refresh
  // re-fetched the RSC → the inbox page suspended on its parallel catalog
  // calls → the inbox `loading.tsx` skeleton mounted for ~50-150ms → the
  // shell unmounted and remounted. Subsequent mutations against an already-
  // populated cache didn't suspend, so the flicker only showed up on the
  // empty-catalog → first-entry transition.
  //
  // startTransition tells React: "this is a low-priority update, keep
  // showing the OLD content while the new RSC streams in." Suspense
  // boundaries inside the route don't unmount; the existing UI stays put
  // and silently swaps when the new data lands.
  const [, startTransition] = useTransition();

  useEffect(() => {
    const socket = getClientSocket();

    const onChanged: Parameters<typeof socket.on<"team:catalog:changed">>[1] = () => {
      if (pending.current !== null) return;
      pending.current = window.setTimeout(() => {
        pending.current = null;
        startTransition(() => router.refresh());
      }, REFRESH_COALESCE_MS);
    };

    socket.on("team:catalog:changed", onChanged);
    return () => {
      socket.off("team:catalog:changed", onChanged);
      if (pending.current !== null) {
        window.clearTimeout(pending.current);
        pending.current = null;
      }
    };
  }, [router, startTransition]);
}
