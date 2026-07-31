/**
 * Pure templates-cookies primitives — NO `"use client"` directive. The
 * `/templates` SSR page reads the persisted filter / search cookies to
 * seed the initial render; previously these helpers lived inside
 * `templates-view.tsx` under `"use client"` and the page's import
 * crashed at runtime with "Attempted to call X() from the server but X
 * is on the client." Mirror of the inbox-filter and broadcasts-cookies
 * splits, same root cause.
 */

export type TemplatesStatusFilter =
  | "all"
  | "approved"
  | "pending"
  | "rejected"
  | "paused"
  | "disabled"
  | "archived";

const VALID_STATUS_FILTERS: ReadonlySet<TemplatesStatusFilter> = new Set([
  "all",
  "approved",
  "pending",
  "rejected",
  "paused",
  "disabled",
  "archived",
]);

export const TEMPLATES_STATUS_COOKIE = "templates-status";
export const TEMPLATES_SEARCH_COOKIE = "templates-search";

/** Parse the persisted status cookie. Defaults to "all" on missing / invalid. */
export function parseTemplatesStatus(raw: string | undefined): TemplatesStatusFilter {
  return raw && VALID_STATUS_FILTERS.has(raw as TemplatesStatusFilter)
    ? (raw as TemplatesStatusFilter)
    : "all";
}
