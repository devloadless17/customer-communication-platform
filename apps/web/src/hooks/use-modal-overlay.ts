"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Shared overlay primitives — bury the body-scroll-lock + focus-trap +
 * Escape-to-close pattern in one hook so every custom modal in the app
 * uses the same correct implementation. Without this, each dialog wrote
 * its own partial version (no scroll lock, no Tab trap, no focus return).
 *
 * The two pieces are exposed separately so consumers that only need one
 * (e.g. a lightbox that wants scroll lock but no focus trap) don't pay
 * for both.
 */

/**
 * Pin the body scroll while an overlay is open. Restores the prior
 * `overflow` value on close so a stack of overlays (toast above modal)
 * doesn't permanently freeze the page.
 *
 * Ref-counted via a module-level counter so two overlays open at once
 * both restore correctly when the inner one closes — the outer one's
 * lock stays in place until IT closes.
 */
let lockCount = 0;
let priorOverflow: string | null = null;
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    if (lockCount === 0) {
      priorOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    lockCount += 1;
    return () => {
      lockCount -= 1;
      if (lockCount === 0) {
        document.body.style.overflow = priorOverflow ?? "";
        priorOverflow = null;
      }
    };
  }, [active]);
}

/**
 * Focus-trap + Escape-to-close + focus restoration. Attach to the
 * dialog's content root via `ref`; pass `onClose` to receive Escape.
 *
 * Tab / Shift+Tab cycles inside the container; focus is returned to
 * whatever element opened the dialog when it closes.
 */
export function useFocusTrap<T extends HTMLElement>(
  ref: RefObject<T | null>,
  active: boolean,
  onClose?: () => void,
): void {
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!active) return;
    lastFocusedRef.current = document.activeElement as HTMLElement | null;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose?.();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const focusables = ref.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const activeEl = document.activeElement;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      lastFocusedRef.current?.focus?.();
    };
    // ref is stable across renders by convention; depending on it here
    // would force consumers to memoize.
  }, [active, onClose, ref]);
}

/**
 * Combined helper — every modal in this app wants both. Pass the dialog
 * content ref + open flag + close callback.
 */
export function useModalOverlay<T extends HTMLElement>(
  ref: RefObject<T | null>,
  open: boolean,
  onClose?: () => void,
): void {
  useBodyScrollLock(open);
  useFocusTrap(ref, open, onClose);
}
