"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";

import { Input } from "@/components/ui/input";

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
  onSave: (next: string) => Promise<boolean>;
  onDelete?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
    setBusy(true);
    const ok = await onSave(draft);
    setBusy(false);
    if (ok) setEditing(false);
  }

  return (
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
          className={`min-w-0 flex-1 truncate rounded px-1 py-0.5 text-left hover:bg-accent ${
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
              setEditing(false);
            }
          }}
          disabled={busy}
          className={`h-6 min-w-0 flex-1 text-xs ${mono ? "font-mono" : ""}`}
        />
      )}
      {onDelete && !editing && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Remove ${label}`}
          className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-0 transition hover:bg-accent hover:text-destructive group-hover:opacity-100"
        >
          <Trash2 className="size-3" />
        </button>
      )}
    </div>
  );
}
