"use client";

import { useEffect } from "react";

/**
 * Chunk-load error recovery.
 *
 * After a deploy ships new `_next/static/chunks/<hash>.js`, any open tab
 * still references the OLD hash. Soft navigation (`router.push`) fetches
 * the new chunk for the destination route → 404 → Next.js logs a
 * `ChunkLoadError` and the route silently fails to render. The user sees
 * the previous page hang or a blank state with no obvious cause.
 *
 * Fix: catch the chunk-load failure at the window level and hard-reload
 * the page. The reload pulls fresh HTML which references the new chunk
 * hashes, and the user is back in business in ~1s. Refresh once per
 * outage so a persistent failure doesn't infinite-loop reload.
 *
 * Detected via:
 *   - `error.name === "ChunkLoadError"` (webpack's standard error name)
 *   - `error.message` containing "Loading chunk" or "Failed to fetch
 *     dynamically imported module" (esbuild / native import())
 *   - PromiseRejectionEvent reason with the same signature
 */

const RELOAD_KEY = "ccp:chunk-reload-at";
const RELOAD_DEBOUNCE_MS = 60_000;

function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const obj = err as { name?: string; message?: string };
  if (obj.name === "ChunkLoadError") return true;
  const msg = obj.message ?? "";
  return (
    msg.includes("Loading chunk") ||
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    // Next.js 15 wraps the message slightly differently
    msg.includes("Loading CSS chunk")
  );
}

function maybeReload(): void {
  // Debounce: if we already reloaded recently and we're STILL hitting
  // chunk errors, the new bundle is genuinely broken — don't infinite-
  // loop reload.
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_DEBOUNCE_MS) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // sessionStorage disabled — proceed anyway; once per page-load is
    // acceptable in the worst case.
  }
  // eslint-disable-next-line no-console
  console.warn("[chunk-reload] detected stale chunk reference, reloading");
  window.location.reload();
}

export function ChunkErrorReload() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (isChunkLoadError(e.error)) maybeReload();
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isChunkLoadError(e.reason)) maybeReload();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
