"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, HelpCircle } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * App-wide replacement for `window.confirm` / `window.alert` — a small modal
 * that matches the rest of the UI instead of the browser's native chrome.
 *
 * Usage:
 *
 *   const { confirm, confirmDialog } = useConfirm();
 *   ...
 *   if (await confirm({ title: "Delete this?", destructive: true, confirmLabel: "Delete" })) {
 *     // do it
 *   }
 *   ...
 *   return (<>{ ...your JSX... }{confirmDialog}</>);
 *
 * `confirm()` returns a Promise<boolean>. For an alert-style "just tell them"
 * message, pass `mode: "alert"` (single OK button, resolves true on dismiss).
 */

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as a destructive action + show a warning icon. */
  destructive?: boolean;
  /** "alert" = single button, no cancel (a drop-in for window.alert). */
  mode?: "confirm" | "alert";
}

export function ConfirmDialog({
  open,
  options,
  onResolve,
}: {
  open: boolean;
  options: ConfirmOptions | null;
  onResolve: (value: boolean) => void;
}) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Restore focus to whatever was focused before the dialog opened — caller
  // shouldn't have to remember to do this.
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    lastFocusedRef.current = document.activeElement as HTMLElement | null;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onResolve(false);
        return;
      }
      // Trap Tab inside the dialog so keyboard users don't escape into the
      // page underneath. Cycles between the first and last focusable element.
      if (e.key === "Tab" && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Return focus to the trigger when the dialog closes.
      lastFocusedRef.current?.focus?.();
    };
  }, [open, onResolve]);

  if (!open || !options) return null;
  const {
    title,
    description,
    confirmLabel = options.mode === "alert" ? "OK" : "Confirm",
    cancelLabel = "Cancel",
    destructive = false,
    mode = "confirm",
  } = options;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onResolve(false);
      }}
    >
      <div className="w-full max-w-sm rounded-lg border border-border bg-card text-card-foreground shadow-xl">
        <div className="flex items-start gap-3 p-5">
          <div
            className={
              destructive
                ? "inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
                : "inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
            }
          >
            {destructive ? <AlertTriangle className="size-4" /> : <HelpCircle className="size-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold">{title}</h2>
            {description && (
              <p id={descId} className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          {mode === "confirm" && (
            <Button variant="ghost" size="sm" onClick={() => onResolve(false)}>
              {cancelLabel}
            </Button>
          )}
          <Button
            size="sm"
            variant={destructive ? "destructive" : "default"}
            autoFocus
            onClick={() => onResolve(true)}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface DialogState {
  open: boolean;
  options: ConfirmOptions | null;
  resolve: ((value: boolean) => void) | null;
}

export function useConfirm() {
  const [state, setState] = useState<DialogState>({
    open: false,
    options: null,
    resolve: null,
  });

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        // If a previous dialog is still pending (caller hasn't awaited yet,
        // or another caller raced in), resolve it as cancelled so the awaiter
        // doesn't hang forever. Without this, the older promise is silently
        // orphaned.
        setState((prev) => {
          prev.resolve?.(false);
          return { open: true, options, resolve };
        });
      }),
    [],
  );

  /** Drop-in for `window.alert` — single OK button. */
  const alert = useCallback(
    (title: string, description?: string) =>
      new Promise<void>((resolve) => {
        setState((prev) => {
          // Same orphaned-promise guard as `confirm` above.
          prev.resolve?.(false);
          return {
            open: true,
            options: { title, description, mode: "alert" },
            resolve: () => resolve(),
          };
        });
      }),
    [],
  );

  const handleResolve = useCallback((value: boolean) => {
    setState((prev) => {
      prev.resolve?.(value);
      return { open: false, options: null, resolve: null };
    });
  }, []);

  const confirmDialog = (
    <ConfirmDialog open={state.open} options={state.options} onResolve={handleResolve} />
  );

  return { confirm, alert, confirmDialog };
}
