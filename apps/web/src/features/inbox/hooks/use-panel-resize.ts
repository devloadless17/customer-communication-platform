"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drag-to-resize state for an inbox side column (the conversation list or the
 * contact-details panel). Width is persisted to localStorage and clamped to
 * [min, max]. The consumer applies the width however it likes (CSS var or
 * inline `width`) and gates it to desktop so mobile layouts are untouched.
 *
 * `width` is `null` until mount so SSR and the first client paint both fall
 * back to the caller's CSS default — no hydration mismatch. After mount it
 * reads localStorage (defaulting to `def`).
 *
 * `grow` says which edge the handle sits on, so a drag in the natural
 * direction enlarges the panel:
 *   - "right" — handle on the panel's RIGHT edge (the list): width += dx.
 *   - "left"  — handle on the panel's LEFT edge (the details): width -= dx.
 */
interface PanelResizeOptions {
  storageKey: string;
  min: number;
  max: number;
  def: number;
  grow?: "left" | "right";
  /** Optional dynamic cap computed at drag-start from live geometry — used to
   *  stop a drag before it squishes a sibling (e.g. the message thread) below a
   *  usable width. Receives the handle element so it can measure siblings.
   *  Returns the max px width allowed for THIS drag; the effective max is
   *  min(static max, this). Recomputed on each pointer-down (cheap), so it
   *  always reflects the current window/other-panel sizes. */
  getDragMax?: (handleEl: HTMLElement) => number;
}

const STEP = 16; // px per arrow-key press

export function usePanelResize({
  storageKey,
  min,
  max,
  def,
  grow = "right",
  getDragMax,
}: PanelResizeOptions) {
  const [width, setWidth] = useState<number | null>(null);
  // Exposed so consumers can suppress any CSS width-transition while dragging
  // (otherwise each per-pixel update animates over the transition duration and
  // the drag feels laggy / rubber-bands).
  const [dragging, setDragging] = useState(false);
  // Live drag origin — a ref so pointermove doesn't re-bind listeners per pixel.
  // `max` is the effective cap for the in-progress drag (static max, optionally
  // tightened by getDragMax).
  const dragRef = useRef<{ startX: number; startW: number; max: number } | null>(
    null,
  );

  const clampTo = useCallback(
    (n: number, hi: number) => Math.max(min, Math.min(hi, Math.round(n))),
    [min],
  );
  const clamp = useCallback((n: number) => clampTo(n, max), [clampTo, max]);

  useEffect(() => {
    const raw = localStorage.getItem(storageKey);
    const n = raw == null ? NaN : Number(raw);
    setWidth(Number.isFinite(n) ? clamp(n) : def);
  }, [storageKey, def, clamp]);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      setWidth(clampTo(d.startW + (grow === "left" ? -dx : dx), d.max));
    },
    [clampTo, grow],
  );

  const stop = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stop);
    setWidth((w) => {
      if (w != null) localStorage.setItem(storageKey, String(w));
      return w;
    });
  }, [onPointerMove, storageKey]);

  const onHandleDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return; // primary button only
      e.preventDefault();
      const dynMax = getDragMax
        ? getDragMax(e.currentTarget as HTMLElement)
        : Infinity;
      // Effective cap: never below `min` (a tiny window shouldn't invert the
      // clamp), never above the static `max`.
      const effMax = Math.max(min, Math.min(max, dynMax));
      dragRef.current = { startX: e.clientX, startW: width ?? def, max: effMax };
      setDragging(true);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", stop);
    },
    [width, def, min, max, getDragMax, onPointerMove, stop],
  );

  // Keyboard a11y: arrows nudge the width when the separator is focused. The
  // arrow that visually enlarges the panel depends on which edge it's on.
  const onHandleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      const signed = grow === "left" ? -dir : dir;
      setWidth((w) => {
        const next = clamp((w ?? def) + signed * STEP);
        localStorage.setItem(storageKey, String(next));
        return next;
      });
    },
    [clamp, def, grow, storageKey],
  );

  // Drop window listeners if we unmount mid-drag (fast route change while
  // dragging).
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stop);
    },
    [onPointerMove, stop],
  );

  return { width, dragging, onHandleDown, onHandleKeyDown };
}
