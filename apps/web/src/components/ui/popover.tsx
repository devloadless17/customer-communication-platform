"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@ccp/shared/utils";

/**
 * Minimal portal-anchored popover.
 *
 * Why not Radix DropdownMenu: the filter popovers hold a search <input>, and
 * Radix's typeahead steals keystrokes from it. Why portal-to-body: the contact
 * picker renders the filter bar inside an `overflow-y-auto` modal, which would
 * clip an absolutely-positioned popover. Portaling out with fixed positioning
 * (recomputed on scroll/resize) keeps it unclipped on the page AND in the modal.
 *
 * Controlled: the parent owns `open`. Closes on outside-click + Escape. The
 * trigger lives in `children`; the floating panel is `content`.
 */
export function Popover({
  open,
  onOpenChange,
  children,
  content,
  align = "end",
  sideOffset = 6,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  content: ReactNode;
  /** "start" anchors the panel's left edge to the trigger; "end" the right. */
  align?: "start" | "end";
  sideOffset?: number;
  className?: string;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; right: number } | null>(
    null,
  );
  // Keep the panel mounted briefly after close so the exit animation plays,
  // then unmount. Mirrors the Dialog/Radix overlay enter+exit feel.
  const [rendered, setRendered] = useState(open);
  useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }
    const t = setTimeout(() => setRendered(false), 120);
    return () => clearTimeout(t);
  }, [open]);

  const reposition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({
      top: r.bottom + sideOffset,
      left: r.left,
      right: window.innerWidth - r.right,
    });
  }, [sideOffset]);

  // Measure on open; keep aligned while scrolling (capture catches inner
  // scroll containers like the picker modal body) or resizing.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || contentRef.current?.contains(t)) return;
      onOpenChange(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onOpenChange(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  return (
    <>
      <div ref={anchorRef} className="inline-flex">
        {children}
      </div>
      {(open || rendered) && rect && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={contentRef}
              style={{
                position: "fixed",
                top: rect.top,
                ...(align === "end" ? { right: rect.right } : { left: rect.left }),
              }}
              className={cn(
                "z-60 rounded-lg border border-border bg-popover text-popover-foreground shadow-md",
                open
                  ? "animate-in fade-in-0 zoom-in-95 duration-150"
                  : "animate-out fade-out-0 zoom-out-95 duration-100",
                className,
              )}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
