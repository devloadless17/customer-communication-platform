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
  const wasEditingRef = useRef(editing);

  useEffect(() => {
    const justEntered = editing && !wasEditingRef.current;
    wasEditingRef.current = editing;
    if (editing) {
      // Seed the draft ONLY on the false→true transition — re-seeding on every
      // `value` change would clobber an in-progress draft when a teammate's
      // `contact:updated` socket frame silently re-seeds the field mid-type.
      if (justEntered) setDraft(value);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing, value]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group -ml-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-base font-semibold hover:bg-accent/50"
      >
        <span className="truncate">{value}</span>
        <Pencil className="size-3 opacity-30 transition-opacity group-hover:opacity-100" />
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
    // finally, not a bare await — a rejected fetch used to strand busy=true and
    // permanently lock the name input (2026-08-11 stuck-pending audit).
    let ok = false;
    try {
      ok = await onSave(trimmed);
    } finally {
      setBusy(false);
    }
    if (ok) setEditing(false);
  }

  return (
    <div className="flex items-center gap-1">
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
        className="h-7 w-full text-base font-semibold"
      />
    </div>
  );
}
