"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Trash2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";

/**
 * A label/value row that becomes an Input on click.
 *  - Enter or blur → save
 *  - Escape       → cancel
 *  - Empty save   → clears the value (the parent decides whether that means
 *                   `null` or "stay key but blank"; this component just
 *                   forwards the trimmed string).
 */
export function EditableField({
  icon: Icon,
  label,
  value,
  displayValue,
  placeholder,
  mono,
  actionHref,
  actionLabel,
  ActionIcon = ExternalLink,
  onSave,
  onDelete,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  /** The raw value the input edits and that gets saved. */
  value: string;
  /** Optional pretty-printed string shown in the read view. Defaults to `value`. */
  displayValue?: string;
  placeholder?: string;
  mono?: boolean;
  /** When set (and a value exists, and not editing), renders a small action
   *  link that makes the field actionable — e.g. a `mailto:` for email. The
   *  read-view value stays a click-to-edit button; this is a sibling icon. */
  actionHref?: string;
  /** Accessible label for the action link (defaults to "Open"). */
  actionLabel?: string;
  /** Icon for the action link. Defaults to ExternalLink. */
  ActionIcon?: React.ComponentType<{ className?: string }>;
  onSave: (next: string) => Promise<boolean>;
  onDelete?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { confirm, confirmDialog } = useConfirm();

  useEffect(() => {
    if (editing) {
      setDraft(value);
      // Defer focus until after Radix/whatever finishes mounting the input.
      const id = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [editing, value]);

  async function commit() {
    // No-op guard: a stray blur (or Enter on an untouched field) must not fire
    // a PATCH. Parent onSave handlers already early-return on an unchanged
    // value, but short-circuiting here also skips the busy-spinner flash and a
    // wasted round-trip — and keeps blur=commit from re-saving a value the user
    // never edited. We compare the raw strings (the parent owns trim/null
    // normalization), so the only thing skipped is a genuine identical value.
    if (draft === value) {
      setEditing(false);
      return;
    }
    setBusy(true);
    const ok = await onSave(draft);
    setBusy(false);
    if (ok) setEditing(false);
  }

  // Esc → cancel: restore the draft to the original and leave edit mode WITHOUT
  // saving. Pulled out of the keydown handler so it can't accidentally race the
  // blur-commit (Radix Input blurs on Escape) — we reset the draft first so the
  // subsequent blur sees draft === value and no-ops.
  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  return (
    <>
    <div className="group flex items-start gap-2 py-1 text-xs">
      {Icon ? (
        <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <span className="w-20 shrink-0 truncate text-muted-foreground" title={label}>
        {label}
      </span>
      {!editing ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className={`min-w-0 flex-1 truncate rounded-md px-1 py-0.5 text-left hover:bg-accent/50 ${
            value ? "" : "text-muted-foreground"
          } ${mono ? "font-mono" : ""}`}
        >
          {value ? (displayValue ?? value) : placeholder || "—"}
        </button>
      ) : (
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          disabled={busy}
          className={`h-6 min-w-0 flex-1 text-xs ${mono ? "font-mono" : ""}`}
        />
      )}
      {actionHref && value && !editing && (
        <a
          href={actionHref}
          aria-label={actionLabel ?? "Open"}
          // Match the delete button's hover-reveal affordance so the action
          // doesn't add visual weight to the row at rest.
          className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <ActionIcon className="size-3" />
        </a>
      )}
      {onDelete && !editing && (
        <button
          type="button"
          onClick={async () => {
            const ok = await confirm({
              title: `Remove ${label}?`,
              description: "This clears the field from this contact.",
              confirmLabel: "Remove",
              destructive: true,
            });
            if (ok) await onDelete?.();
          }}
          aria-label={`Remove ${label}`}
          className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-destructive group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Trash2 className="size-3" />
        </button>
      )}
    </div>
    {confirmDialog}
    </>
  );
}
