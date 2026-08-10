"use client";

import { useEffect, useRef, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";

import { getClientSocket } from "@/lib/socket-client";

import type { ServerToClientEvents } from "@ccp/shared/socket/events";

type CatalogScope = Parameters<
  ServerToClientEvents["team:catalog:changed"]
>[0]["scope"];

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

/**
 * Scope-vs-pathname affinity: which top-level routes actually CONSUME a given
 * catalog. A scope event that doesn't intersect the current pathname is
 * dropped — refreshing the inbox because someone added an API key elsewhere
 * is wasted bandwidth and a wasted RSC round-trip. Default = refresh, so any
 * route not listed here keeps current behavior (no regressions when a new
 * route is added that consumes a known catalog).
 *
 * Sidebar-global scopes ("members", "team-channels") are NOT listed — they
 * always refresh because the rail (avatars, channel list) is rendered above
 * every route. Same for "stages" / "tags" / "contact-fields" / "snippets" /
 * "whatsapp-templates" which the inbox reply-box / panels read on every
 * conversation render.
 *
 * Only scopes whose consumers live on a NARROW route set are listed here.
 */
const SCOPE_AFFINITY: Partial<Record<CatalogScope, readonly string[]>> = {
  // Workflow definitions are only on the workflows canvas + lists.
  workflows: ["/workflows"],
  // Audience groups are only used inside the broadcasts flow.
  "audience-groups": ["/broadcasts"],
  // Pending invites are admin-only and only shown on team settings.
  invites: ["/settings/members"],
  // API keys live on the integrations settings page only.
  "api-keys": ["/settings/integrations"],
};

function isPathnameRelevantToScope(
  scope: CatalogScope,
  pathname: string | null,
): boolean {
  const prefixes = SCOPE_AFFINITY[scope];
  if (!prefixes) return true;
  if (!pathname) return true;
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function useCatalogSync(): void {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const pending = useRef<number | null>(null);
  // Whether a relevant scope was seen in the current coalesce window. A burst
  // mixing relevant + irrelevant scopes still refreshes (one is enough).
  const pendingRelevant = useRef(false);
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

    const onChanged: Parameters<typeof socket.on<"team:catalog:changed">>[1] = (payload) => {
      if (isPathnameRelevantToScope(payload.scope, pathnameRef.current)) {
        pendingRelevant.current = true;
      }
      if (pending.current !== null) return;
      pending.current = window.setTimeout(() => {
        pending.current = null;
        const shouldRefresh = pendingRelevant.current;
        pendingRelevant.current = false;
        if (!shouldRefresh) return;
        startTransition(() => router.refresh());
      }, REFRESH_COALESCE_MS);
    };

    // A SERVER-FORCED disconnect is itself a catalog-class signal: the server
    // only calls `disconnect(true)` on a socket when the session's shape
    // changed under it (agent-visibility flip, role change, workspace
    // revocation), and the caches are always busted BEFORE the disconnect —
    // so an RSC re-derive here reads the new truth. This is the reliable
    // path: the flip's own `team:catalog:changed` frame is emitted before the
    // disconnect but can be lost in the closing transport's write buffer.
    const onDisconnect = (reason: string) => {
      if (reason !== "io server disconnect") return;
      startTransition(() => router.refresh());
    };

    socket.on("team:catalog:changed", onChanged);
    socket.on("disconnect", onDisconnect);
    return () => {
      socket.off("team:catalog:changed", onChanged);
      socket.off("disconnect", onDisconnect);
      if (pending.current !== null) {
        window.clearTimeout(pending.current);
        pending.current = null;
      }
      pendingRelevant.current = false;
    };
  }, [router, startTransition]);
}
