"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, Settings2, X } from "lucide-react";
import Link from "next/link";

import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { cn } from "@ccp/shared/utils";
import type { ContactFieldOption } from "@ccp/shared/types";

/**
 * Pill picker for a SELECT-type custom field — the client-named "stage-like"
 * dimensions (Source, From, …). Deliberately a sibling of
 * `ContactStagePicker`, not a refactor of it: the stage picker stays coupled
 * to stage semantics (default stage, its settings link), while this one is
 * generic over any field's option catalog.
 *
 * The saved contact value is the OPTION ID; `onChange(null)` clears the
 * value (unlike stages, a select field is optional).
 *
 * The "Manage…" footer link is gated on `canManage` and lands on
 * /settings/contact-fields, where the option catalog is edited.
 */
export function ContactFieldSelectPicker({
  fieldLabel,
  options,
  currentOptionId,
  onChange,
  canManage,
  size = "md",
}: {
  /** The field's display label — popover header + empty-state copy. */
  fieldLabel: string;
  options: ContactFieldOption[];
  currentOptionId: string | null | undefined;
  /** Returns a promise that resolves on save; the picker shows a spinner
   *  while it's pending and closes itself once it resolves. */
  onChange: (optionId: string | null) => Promise<void>;
  canManage: boolean;
  size?: "xs" | "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (!boxRef.current) return;
      if (!boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // A stale id (option deleted since this contact was written) renders the
  // same as "no value" — the catalog is the truth the picker shows.
  const current = options.find((o) => o.id === currentOptionId) ?? null;
  const popoverAlign = size === "md" ? "left-0" : "right-0";
  const triggerHeight = size === "xs" ? "h-6" : size === "sm" ? "h-7" : "h-8";
  const dotSize = size === "xs" ? "size-2" : "size-2.5";
  const textSize = size === "xs" ? "text-2xs" : "text-xs";

  async function pick(optionId: string | null) {
    if (optionId === (current?.id ?? null) || saving) return;
    setSaving(true);
    try {
      await onChange(optionId);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div ref={boxRef} className="relative inline-flex max-w-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={options.length === 0}
        className={cn(
          "inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border px-2",
          triggerHeight,
          textSize,
          current
            ? "border-border bg-card text-foreground hover:bg-accent"
            : "border-dashed border-border text-muted-foreground hover:bg-accent",
          options.length === 0 && "cursor-not-allowed opacity-60",
        )}
        title={
          options.length === 0
            ? `No options yet — add some in Settings → Contact fields.`
            : current
              ? `${fieldLabel}: ${current.name}`
              : `Pick ${fieldLabel}`
        }
      >
        {current ? (
          <>
            <span
              className={cn(
                "inline-block shrink-0 rounded-full",
                dotSize,
                tagColorClasses(current.color).solid,
              )}
            />
            <span className="truncate font-medium">{current.name}</span>
          </>
        ) : (
          <span>Set…</span>
        )}
        {saving ? (
          <Loader2 className="size-3 shrink-0 animate-spin opacity-70" />
        ) : (
          <ChevronDown className="size-3 shrink-0 opacity-50" />
        )}
      </button>

      {open && (
        <div
          className={cn(
            "absolute top-full z-30 mt-1 w-60 overflow-hidden rounded-xl border border-border bg-popover shadow-xl",
            popoverAlign,
          )}
        >
          <div className="border-b border-border px-3 py-2 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
            {fieldLabel}
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {options.length === 0 && (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                No options yet.
              </li>
            )}
            {options.map((o) => {
              const isCurrent = o.id === currentOptionId;
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => void pick(o.id)}
                    disabled={isCurrent || saving}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                      isCurrent && "bg-accent/40",
                      saving && "cursor-wait opacity-60",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block size-2.5 shrink-0 rounded-full",
                        tagColorClasses(o.color).solid,
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{o.name}</span>
                    {isCurrent && <Check className="size-3.5 text-primary" />}
                  </button>
                </li>
              );
            })}
            {current && (
              <li>
                <button
                  type="button"
                  onClick={() => void pick(null)}
                  disabled={saving}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    saving && "cursor-wait opacity-60",
                  )}
                >
                  <X className="size-3" />
                  Clear
                </button>
              </li>
            )}
          </ul>
          {canManage && (
            <Link
              href="/settings/contact-fields"
              className="flex items-center gap-2 border-t border-border bg-muted/30 px-3 py-2 text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Settings2 className="size-3" />
              Manage options…
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
