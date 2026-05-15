"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Users, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ContactBrowser } from "@/components/contacts/contact-browser";
import type {
  ContactFieldDefinition,
  ContactListItem,
  ContactStage,
  Tag,
} from "@/lib/types";

/** Minimal id → display shape, shared with {@link ContactMultiSelectField}. */
export interface ContactLabel {
  id: string;
  name: string;
  phoneNumber: string;
}

/**
 * Modal contact picker — the single place anything in the app uses to "pick
 * some contacts". Wraps {@link ContactBrowser} (same search / filter / paginate
 * UX as the Contacts page) in a dialog with a confirm bar.
 *
 * `onConfirm` returns the final id list AND the display labels for every row
 * the user actually saw while picking, so the caller can render chips without
 * a follow-up lookup. The dialog opens with `initialSelectedIds` pre-checked
 * and works as a full editor of that set.
 */
export function ContactSelectDialog({
  open,
  onClose,
  onConfirm,
  initialSelectedIds = [],
  fieldDefinitions = [],
  tags = [],
  stages = [],
  title = "Select contacts",
  description,
  confirmLabel = "Use selection",
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (contactIds: string[], seenLabels: ContactLabel[]) => void;
  initialSelectedIds?: string[];
  fieldDefinitions?: ContactFieldDefinition[];
  tags?: Tag[];
  stages?: ContactStage[];
  title?: string;
  description?: string;
  confirmLabel?: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelectedIds));
  // Labels for every contact row the browser has rendered this session.
  const seenLabels = useRef<Map<string, ContactLabel>>(new Map());

  // Reset the working set every time the dialog is (re)opened so it always
  // reflects the caller's current selection, not a stale one.
  useEffect(() => {
    if (open) {
      setSelected(new Set(initialSelectedIds));
      seenLabels.current = new Map();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  function rememberRows(items: ContactListItem[]) {
    for (const i of items) {
      seenLabels.current.set(i.contact.id, {
        id: i.contact.id,
        name: i.contact.name,
        phoneNumber: i.contact.phoneNumber,
      });
    }
  }

  function confirm() {
    const ids = Array.from(selected);
    const labels = ids
      .map((id) => seenLabels.current.get(id))
      .filter((l): l is ContactLabel => Boolean(l));
    onConfirm(ids, labels);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-12"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-card text-card-foreground shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            {description && (
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <ContactBrowser
            selectedIds={selected}
            onSelectedChange={setSelected}
            fieldDefinitions={fieldDefinitions}
            tags={tags}
            stages={stages}
            onItemsLoaded={rememberRows}
          />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="size-3.5" />
            <span className="tabular-nums">{selected.size}</span> selected
            {selected.size > 0 && (
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="ml-1 hover:text-foreground hover:underline"
              >
                Clear all
              </button>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={selected.size === 0}
              title={selected.size === 0 ? "Tick at least one contact first" : undefined}
              onClick={confirm}
            >
              <Check className="size-3.5" />
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
