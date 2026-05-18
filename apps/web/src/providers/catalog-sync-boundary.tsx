"use client";

import type { ReactNode } from "react";

import { useCatalogSync } from "@/hooks/use-catalog-sync";

/**
 * Mounts {@link useCatalogSync} for everything below it. Used by every
 * authenticated area layout (settings, contacts, broadcasts, templates,
 * automations) so a `team:catalog:changed` socket event reaches the page
 * the agent is currently looking at — not only the inbox shell.
 *
 * The /inbox route has no layout of its own (single-page workspace), so
 * InboxShell still mounts the hook directly. The two mounts never overlap
 * — pages are only ever rendered through one of these branches at a time.
 *
 * Body is render-only so the boundary doesn't introduce a new DOM node.
 */
export function CatalogSyncBoundary({ children }: { children: ReactNode }) {
  useCatalogSync();
  return <>{children}</>;
}
