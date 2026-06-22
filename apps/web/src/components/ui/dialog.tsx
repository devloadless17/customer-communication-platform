"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@ccp/shared/utils";
import { useModalOverlay } from "@/hooks/use-modal-overlay";

/**
 * Centered-modal primitive — the ONE canonical backdrop + card chrome every
 * dialog in the app shares. Before this, ~9 dialogs each hand-rolled their own
 * `fixed inset-0` overlay with divergent specs (scrim `bg-black/50` vs `/40`,
 * `backdrop-blur` vs `-xs` vs `-sm`, `z-50` vs `z-60`, `items-start` vs
 * `items-center`, `rounded-lg` vs `-xl`, `shadow-lg` vs `-xl` vs `-2xl`), so
 * every modal open looked slightly different. This collapses the chrome to a
 * single source of truth; consumers pass content + a max-width via `className`.
 *
 * Usage:
 *
 *   <Dialog open={open} onClose={onClose}>
 *     <DialogContent className="max-w-2xl" ariaLabel="Pick contacts">
 *       …your content…
 *     </DialogContent>
 *   </Dialog>
 *
 * Wires through `useModalOverlay` (body-scroll-lock + focus-trap +
 * Escape-to-close + focus-into-dialog + focus-restore) — the same hook the
 * sheet / confirm dialog already use, so behavior stays identical. The overlay
 * stack inside that hook means a `Dialog` opened on top of another overlay
 * closes only itself on Escape.
 *
 * Portal target is `document.body` so the fixed overlay isn't trapped inside a
 * transformed ancestor — virtualized rows in team chat / inbox set
 * `transform: translateY(...)`, which creates a containing block for
 * `position: fixed` descendants; without the portal the dialog would render
 * behind the surrounding chrome. SSR-safe: the `document` guard short-circuits
 * on the server (consumers only mount this on the client, behind an `open`
 * gate).
 */

const SCRIM_CLASS =
  "fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs";

// Enter/exit fade+scale duration — matches the Radix dropdown/popover motion so
// every overlay in the app opens and closes with one feel. Kept just under the
// .animate-scale-in window. Reduced-motion users get an instant swap via the
// `.animate-in/.animate-out` override in globals.css (tw-animate-css ships NO
// reduced-motion guard of its own — that block is what collapses this).
const ANIM_MS = 150;

interface DialogCtx {
  /** Focus-trap container ref — must land on the card (`DialogContent`). */
  ref: React.RefObject<HTMLDivElement | null>;
  /** True during the exit animation window (open just flipped false). */
  closing: boolean;
}
const DialogContext = createContext<DialogCtx | null>(null);

export function Dialog({
  open,
  onClose,
  children,
  /** Classes on the overlay scrim (rarely needed). */
  overlayClassName,
  /** Skip backdrop-click-to-close (e.g. a mid-submit dialog that shouldn't
   *  vanish on a stray click). Escape is still owned by `useModalOverlay`. */
  dismissOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  overlayClassName?: string;
  dismissOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Body-scroll-lock + focus-trap + Escape — shared with every other modal.
  // The card (`DialogContent`) carries `ref`; it's the focus-trap container.
  // Pass the REAL `open` so scroll-lock/focus behavior is unchanged; the
  // delayed unmount below is purely the exit-animation window.
  useModalOverlay(ref, open, onClose);

  // Keep the overlay mounted for ANIM_MS after `open` flips false so the
  // exit animation can play, then unmount. `closing` drives the animate-out.
  const [rendered, setRendered] = useState(open);
  useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }
    const t = setTimeout(() => setRendered(false), ANIM_MS);
    return () => clearTimeout(t);
  }, [open]);

  if (!open && !rendered) return null;
  // SSR / pre-hydration guard — the portal target is the live DOM body.
  if (typeof document === "undefined") return null;

  const closing = !open;

  return createPortal(
    <DialogContext.Provider value={{ ref, closing }}>
      <div
        className={cn(
          SCRIM_CLASS,
          closing
            ? "animate-out fade-out-0 duration-150"
            : "animate-in fade-in-0 duration-150",
          overlayClassName,
        )}
        onClick={(e) => {
          if (dismissOnBackdrop && e.target === e.currentTarget) onClose();
        }}
      >
        {children}
      </div>
    </DialogContext.Provider>,
    document.body,
  );
}

/**
 * The card itself. Carries the focus-trap `ref` (from `Dialog`'s context) + the
 * ARIA dialog role, since `useFocusTrap` queries focusables inside this element.
 * Defaults to `max-w-md`; override the width — and any layout like
 * `flex flex-col` for full-height dialogs — via `className`. The canonical
 * `max-h-[calc(100svh-2rem)] overflow-y-auto` means it never clips on short
 * viewports; pass `flex flex-col` + an inner scroll region when the card needs
 * a sticky header/footer instead of scrolling as one block.
 */
export function DialogContent({
  children,
  className,
  labelledBy,
  describedBy,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  labelledBy?: string;
  describedBy?: string;
  ariaLabel?: string;
}) {
  const ctx = useContext(DialogContext);
  return (
    <div
      ref={ctx?.ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-label={ariaLabel}
      // `tabIndex={-1}` so `useFocusTrap` can move focus into the container
      // programmatically when no focusable child exists yet.
      tabIndex={-1}
      className={cn(
        "w-full max-w-md max-h-[calc(100svh-2rem)] overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-none",
        // Fade+scale enter/exit (matches the scrim + Radix overlays).
        ctx?.closing
          ? "animate-out fade-out-0 zoom-out-95 duration-150"
          : "animate-in fade-in-0 zoom-in-95 duration-150",
        className,
      )}
    >
      {children}
    </div>
  );
}
