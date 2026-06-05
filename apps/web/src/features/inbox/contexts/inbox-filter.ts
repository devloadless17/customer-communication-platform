/**
 * Pure inbox-filter primitives — NO `"use client"` directive. Server
 * components (e.g. `(app)/inbox/layout.tsx`) read the cookie SSR-side
 * via `parseInboxFilter` to seed the provider's `initialFilter`; the
 * provider + hook live alongside in `inbox-filter-context.tsx` under
 * `"use client"`. Without this split, importing `parseInboxFilter` from
 * a server component crashes at runtime with
 * `Attempted to call X() from the server but X is on the client.`
 */

import type { Filter, PresetFilterId } from "@/features/inbox/components/inbox-controls";

export const INBOX_FILTER_COOKIE = "inbox-filter";
// 1 year. The browser may evict it sooner under storage pressure; on
// next mount the default ("Active") takes over silently.
export const INBOX_FILTER_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

export const INBOX_FILTER_DEFAULT: Filter = { kind: "preset", id: "active" };

const VALID_PRESETS: ReadonlySet<PresetFilterId> = new Set([
  "active",
  "all",
  "mine",
  "unassigned",
  "closed",
]);

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
  if (filter.kind === "stage") return `s:${filter.stageId}`;
  return "c"; // calls view
}

/**
 * Parse the cookie back to a `Filter`. Returns null when the cookie is
 * missing or malformed — callers fall back to the default. The layout
 * additionally validates a returned stage id against its loaded `stages`
 * list and ignores stale ids (deleted stage on another tab / device).
 */
export function parseInboxFilter(raw: string | undefined): Filter | null {
  if (!raw) return null;
  if (raw === "c") return { kind: "calls" };
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
