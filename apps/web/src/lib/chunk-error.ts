/**
 * Shared chunk-load-error detection + debounced recovery.
 *
 * After a deploy ships new `_next/static/chunks/<hash>.js` (or after a dev
 * hot-reload rewrites chunk hashes), an open tab still references the OLD hash.
 * Loading that chunk — eagerly on nav, or lazily via `next/dynamic` — 404s and
 * throws a ChunkLoadError. Two paths surface it:
 *   1. The failure escapes to `window` (`error` / `unhandledrejection`) →
 *      caught by ChunkErrorReload.
 *   2. A React error boundary (e.g. inbox/error.tsx → SegmentError) catches it
 *      FIRST during render of a `dynamic()` component, so it NEVER reaches
 *      window. That path is why users saw "Inbox failed to load. Failed to
 *      load chunk …template-picker…" instead of an auto-reload.
 *
 * Both call `reloadForStaleChunk()` so a stale chunk self-heals with one hard
 * reload (fresh HTML → current chunk hashes), debounced so a genuinely broken
 * bundle can't infinite-loop reload.
 */

const RELOAD_KEY = "ccp:chunk-reload-at";
const RELOAD_DEBOUNCE_MS = 60_000;

export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const obj = err as { name?: string; message?: string };
  if (obj.name === "ChunkLoadError") return true;
  const msg = obj.message ?? "";
  return (
    msg.includes("Loading chunk") ||
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    // Turbopack's dynamic-entry async loader phrases it this way (the exact
    // wording in the inbox error screen: "Failed to load chunk … from module
    // … next/dynamic entry, async loader").
    msg.includes("Failed to load chunk") ||
    // Next.js 15 wraps the CSS variant slightly differently
    msg.includes("Loading CSS chunk")
  );
}

/**
 * Hard-reload once to pull a fresh bundle. Returns true if a reload was
 * triggered, false if debounced (already reloaded recently → the new bundle
 * is genuinely broken, don't loop).
 */
export function reloadForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_DEBOUNCE_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // sessionStorage disabled — proceed anyway; once per page-load is
    // acceptable in the worst case.
  }
  console.warn("[chunk-reload] detected stale chunk reference, reloading");
  window.location.reload();
  return true;
}
