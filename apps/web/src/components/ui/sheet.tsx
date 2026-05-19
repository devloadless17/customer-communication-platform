"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "@ccp/shared/utils";
import { useModalOverlay } from "@/hooks/use-modal-overlay";

/**
 * Slide-in side panel — used for mobile navigation drawers (AppRail +
 * SubSidebar), the inbox ContactPanel on small screens, and any other
 * full-height surface that needs to overlay the page on narrow viewports.
 *
 * Reuses the same `useModalOverlay` hook every other modal in the app
 * uses (body-scroll-lock + focus-trap + Escape-to-close + focus return),
 * so behavior matches `confirm-dialog` / lightbox etc.
 *
 * Portal target is `document.body` so the fixed overlay isn't trapped
 * inside a transformed ancestor — same reason ConfirmDialog portals out.
 */

type Side = "left" | "right" | "bottom";

export function Sheet({
  open,
  onOpenChange,
  side = "left",
  children,
  className,
  contentClassName,
  labelledBy,
  describedBy,
  /** Hide the default close (X) button. Use when the children render their own. */
  hideCloseButton,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: Side;
  children: ReactNode;
  /** Classes on the overlay container (rarely needed). */
  className?: string;
  /** Classes on the sliding panel itself — pass a width here (`w-72`, `w-80`, etc). */
  contentClassName?: string;
  labelledBy?: string;
  describedBy?: string;
  hideCloseButton?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Track whether the sheet is mounted at all so we can animate enter +
  // exit. Without this, the panel just appears in its final position.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // Next frame: flip `shown` so the CSS transitions kick in. Without
      // the rAF, React batches the two state updates and the initial
      // off-screen frame never paints.
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(t);
  }, [open]);

  useModalOverlay(ref, open, () => onOpenChange(false));

  if (!mounted) return null;
  if (typeof document === "undefined") return null;

  const slideClass =
    side === "left"
      ? shown
        ? "translate-x-0"
        : "-translate-x-full"
      : side === "right"
        ? shown
          ? "translate-x-0"
          : "translate-x-full"
        : shown
          ? "translate-y-0"
          : "translate-y-full";

  const positionClass =
    side === "left"
      ? "left-0 top-0 h-svh"
      : side === "right"
        ? "right-0 top-0 h-svh"
        : "bottom-0 inset-x-0 max-h-[85svh]";

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={cn(
        "fixed inset-0 z-50 bg-black/50 transition-opacity duration-200",
        shown ? "opacity-100" : "opacity-0",
        className,
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) onOpenChange(false);
      }}
    >
      <div
        ref={ref}
        className={cn(
          "absolute flex flex-col bg-background text-foreground shadow-xl transition-transform duration-200 ease-out",
          positionClass,
          slideClass,
          // Sensible default width for side sheets; callers override via
          // `contentClassName` (e.g. `w-80` for nav, `w-[320px]` for the
          // inbox contact panel on mobile).
          side !== "bottom" && "w-72",
          contentClassName,
        )}
      >
        {!hideCloseButton && (
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="absolute right-2 top-2 z-10 inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
