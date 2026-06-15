/**
 * Cookie names for the inbox drag-to-resize columns. Shared by the SERVER (reads
 * them in the inbox page to SSR each column at its persisted width — no
 * post-refresh resize jump) and the CLIENT hook (`usePanelResize` writes them on
 * resize). Single source of truth so the read and write can't drift apart.
 */
export const INBOX_LIST_WIDTH_COOKIE = "inbox-list-width";
export const INBOX_DETAILS_WIDTH_COOKIE = "inbox-details-width";

/**
 * Parse a width cookie value to a finite number, or null when absent/invalid.
 * The hook clamps to its own [min, max] when seeding, so no clamp is done here.
 */
export function parseWidthCookie(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
