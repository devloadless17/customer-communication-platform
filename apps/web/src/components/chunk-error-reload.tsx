"use client";

import { useEffect } from "react";

import { isChunkLoadError, reloadForStaleChunk } from "@/lib/chunk-error";

/**
 * Window-level chunk-load error recovery.
 *
 * Catches stale-chunk failures that escape to `window` (eager chunk fetch on
 * soft navigation, or a rejected import() with no React boundary above it) and
 * hard-reloads to pull fresh HTML with current chunk hashes.
 *
 * The OTHER path — a `next/dynamic` chunk failing during render, caught by a
 * React error boundary (SegmentError) before it reaches window — is handled in
 * SegmentError itself, which calls the same `reloadForStaleChunk()`. Detection +
 * debounce live in `@/lib/chunk-error` so both paths share one source of truth.
 */
export function ChunkErrorReload() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (isChunkLoadError(e.error)) reloadForStaleChunk();
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isChunkLoadError(e.reason)) reloadForStaleChunk();
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
