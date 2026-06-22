"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { AlertTriangle, HelpCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

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
  /**
   * Type-to-confirm guard for high-blast-radius destructive actions (whole-org
   * delete, large bulk delete). When set, the confirm button stays disabled
   * until the user types this exact string (case-sensitive), e.g. the org name
   * or the literal word "DELETE". Proportional friction without a new dialog
   * pattern.
   */
  requireText?: string;
  /** Label above the type-to-confirm input. Defaults to a generic prompt. */
  requireTextLabel?: React.ReactNode;
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
  const inputId = useId();

  // Type-to-confirm text (cleared whenever a new dialog opens). Lives at the
  // top level so the hooks order stays stable across renders.
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open, options]);

  // Escape / backdrop both resolve as cancelled (the shared <Dialog> owns
  // body-scroll-lock + focus-trap + Escape + portal — see dialog.tsx).
  const onClose = useCallback(() => onResolve(false), [onResolve]);

  if (!open || !options) return null;
  const {
    title,
    description,
    confirmLabel = options.mode === "alert" ? "OK" : "Confirm",
    cancelLabel = "Cancel",
    destructive = false,
    mode = "confirm",
    requireText,
    requireTextLabel,
  } = options;

  // Confirm stays disabled until the typed text matches exactly (when a
  // type-to-confirm guard is set). Trim only trailing/leading whitespace so a
  // stray space doesn't block a correct entry.
  const confirmBlocked = Boolean(requireText) && typed.trim() !== requireText;

  // z-60 keeps a confirm/alert ON TOP of any other open modal (e.g. a confirm
  // fired from inside a Sheet or another Dialog), preserving the prior
  // hand-rolled stacking. The shared <Dialog> portals to <body> + owns chrome.
  return (
    <Dialog open={open} onClose={onClose} overlayClassName="z-60">
      <DialogContent
        className="max-w-sm"
        labelledBy={titleId}
        describedBy={description ? descId : undefined}
      >
        <div className="flex items-start gap-3 p-5">
          <div
            className={
              destructive
                ? "inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
                : "inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
            }
          >
            {destructive ? <AlertTriangle className="size-5" /> : <HelpCircle className="size-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold">{title}</h2>
            {description && (
              <p id={descId} className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
            {requireText && (
              <div className="mt-3">
                <label htmlFor={inputId} className="text-xs text-muted-foreground">
                  {requireTextLabel ?? (
                    <>
                      Type{" "}
                      <span className="font-semibold text-foreground">{requireText}</span>{" "}
                      to confirm
                    </>
                  )}
                </label>
                <Input
                  id={inputId}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  // Focus the input (not the confirm button) so the user can
                  // type immediately; Enter submits only when the text matches.
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !confirmBlocked) onResolve(true);
                  }}
                  className="mt-1 h-9"
                />
              </div>
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
            // Don't steal focus to the confirm button when a type-to-confirm
            // input is present — the input is autofocused instead.
            autoFocus={!requireText}
            disabled={confirmBlocked}
            title={confirmBlocked ? "Type the confirmation text to proceed" : undefined}
            onClick={() => onResolve(true)}
          >
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
