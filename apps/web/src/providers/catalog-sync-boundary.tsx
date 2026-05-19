"use client";

import type { ReactNode } from "react";

import { useCatalogSync } from "@/hooks/use-catalog-sync";

/**
 * Mounts {@link useCatalogSync} for everything below it. Used by every
 * authenticated area layout (settings, contacts, broadcasts, templates,
 * automations, and — as of 2026-05-19 — the inbox) so a
 * `team:catalog:changed` socket event reaches the page the agent is
 * currently looking at.
 *
 * The inbox previously had no layout of its own and mounted the hook
 * inside InboxShell. Now /inbox/layout.tsx wraps the tree in this
 * boundary too, so InboxShell's direct mount was dropped to avoid the
 * duplicate listener firing two refreshes per catalog change.
 *
 * Body is render-only so the boundary doesn't introduce a new DOM node.
 */
export function CatalogSyncBoundary({ children }: { children: ReactNode }) {
  useCatalogSync();
  return <>{children}</>;
}
