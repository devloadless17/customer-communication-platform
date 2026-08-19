/**
 * Pure broadcasts-cookies primitives — NO `"use client"` directive. The
 * `/broadcasts` SSR page reads the persisted filter / view / search cookies
 * to seed the initial server-rendered slice; previously these helpers lived
 * inside the client-component `broadcasts-browser.tsx` and the page's import
 * crashed at runtime with `Attempted to call X() from the server but X is
 * on the client.` Mirror of `inbox-filter.ts` / `inbox-filter-context.tsx`
 * split, same root cause.
 */

export type BroadcastStatusFilter =
  | "all"
  | "scheduled"
  | "materializing"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export type BroadcastView = "table" | "calendar";

export const BROADCASTS_STATUS_COOKIE = "broadcasts-status";
export const BROADCASTS_SEARCH_COOKIE = "broadcasts-search";
export const BROADCASTS_VIEW_COOKIE = "broadcasts-view";

const VALID_STATUSES: ReadonlySet<BroadcastStatusFilter> = new Set([
  "all",
  "scheduled",
  "materializing",
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "canceled",
]);

/** Parse the persisted status cookie. Defaults to "all" on missing / invalid. */
export function parseBroadcastStatus(raw: string | undefined): BroadcastStatusFilter {
  if (raw && VALID_STATUSES.has(raw as BroadcastStatusFilter)) {
    return raw as BroadcastStatusFilter;
  }
  return "all";
}

/** Parse the persisted view cookie. Defaults to "table". */
export function parseBroadcastView(raw: string | undefined): BroadcastView {
  return raw === "calendar" ? "calendar" : "table";
}
