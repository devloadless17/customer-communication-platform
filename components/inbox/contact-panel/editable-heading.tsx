"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";

import { Input } from "@/components/ui/input";

/**
 * The conversation header's contact name. Click-to-edit, Enter saves, Esc
 * cancels. Mirrors the inline-edit pattern of the value rows.
 */
export function EditableHeading({
  value,
  onSave,
}: {
  value: string;
  onSave: (next: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, value]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group inline-flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-base font-semibold hover:bg-accent"
      >
        <span className="truncate">{value}</span>
        <Pencil className="size-3 opacity-0 transition group-hover:opacity-60" />
      </button>
    );
  }

  async function commit() {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(value);
      setEditing(false);
      return;
    }
    setBusy(true);
    const ok = await onSave(trimmed);
    setBusy(false);
    if (ok) setEditing(false);
  }

  return (
    <div className="flex items-center justify-center gap-1">
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
            setDraft(value);
            setEditing(false);
          }
        }}
        disabled={busy}
        className="h-7 max-w-[220px] text-center text-base font-semibold"
      />
    </div>
  );
}
