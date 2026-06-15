"use client";

import { useEffect, useRef, useState } from "react";
import { UserPlus, X } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client-fetch";
import {
  ContactSelectDialog,
  type ContactLabel,
} from "@/features/contacts/components/contact-select-dialog";
import { formatPhone, initials } from "@ccp/shared/utils";
import type { ContactFieldDefinition, ContactStage, Tag } from "@ccp/shared/types";

export type { ContactLabel };

/**
 * Selected-contacts chip strip + a button that opens the shared
 * {@link ContactSelectDialog}. Drop-in form control for "pick some contacts" —
 * audience groups, broadcasts, and whatever comes next.
 *
 * Scales to large teams: the parent only holds the selected *ids*. This
 * component fetches just the display labels it needs (`/api/contacts/lookup`),
 * never the full team contact list. Pass `initialLabels` to seed the cache
 * from the server so editing an existing selection doesn't flash raw ids.
 */
export function ContactMultiSelectField({
  selectedIds,
  onChange,
  initialLabels = [],
  fieldDefinitions,
  tags,
  stages,
  dialogTitle,
  dialogDescription,
  confirmLabel,
  emptyHint = "No contacts picked yet.",
}: {
  selectedIds: string[];
  onChange: (next: string[]) => void;
  /** Optional server-provided labels to seed chips without a round-trip. */
  initialLabels?: ContactLabel[];
  fieldDefinitions?: ContactFieldDefinition[];
  tags?: Tag[];
  stages?: ContactStage[];
  dialogTitle?: string;
  dialogDescription?: string;
  confirmLabel?: string;
  emptyHint?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [labels, setLabels] = useState<Map<string, ContactLabel>>(
    () => new Map(initialLabels.map((c) => [c.id, c] as const)),
  );
  // Ids we've already asked for (resolved or not) — keeps a failed lookup
  // from re-firing on every render.
  const requested = useRef<Set<string>>(new Set(initialLabels.map((c) => c.id)));

  useEffect(() => {
    const missing = selectedIds.filter((id) => !requested.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requested.current.add(id);

    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(
          `/api/contacts/lookup?ids=${encodeURIComponent(missing.join(","))}`,
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { contacts: ContactLabel[] };
        setLabels((prev) => {
          const next = new Map(prev);
          for (const c of data.contacts) next.set(c.id, c);
          return next;
        });
      } catch {
        // Leave the chip showing the raw id — better than crashing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedIds]);

  function remove(id: string) {
    onChange(selectedIds.filter((x) => x !== id));
  }

  function labelFor(id: string): string {
    const l = labels.get(id);
    if (!l) return id;
    return l.name || formatPhone(l.phoneNumber);
  }

  return (
    <div className="flex flex-col gap-2.5">
      {selectedIds.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">{emptyHint}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {selectedIds.map((id) => {
            const label = labelFor(id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 py-0.5 pl-0.5 pr-1.5 text-xs"
              >
                <Avatar className="size-5">
                  <AvatarFallback className="text-[9px]">{initials(label)}</AvatarFallback>
                </Avatar>
                <span className="font-medium">{label}</span>
                <button
                  type="button"
                  onClick={() => remove(id)}
                  className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                  aria-label={`Remove ${label}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setPicking(true)}
        >
          <UserPlus className="size-3.5" />
          {selectedIds.length === 0 ? "Browse & select contacts" : "Edit selection"}
        </Button>
        {selectedIds.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-2xs text-muted-foreground hover:text-foreground hover:underline"
          >
            Clear all
          </button>
        )}
      </div>
      <ContactSelectDialog
        open={picking}
        onClose={() => setPicking(false)}
        onConfirm={(ids, pickedLabels) => {
          // Seed labels from what the dialog already had loaded so freshly
          // picked chips render immediately (no lookup flash).
          if (pickedLabels.length > 0) {
            setLabels((prev) => {
              const next = new Map(prev);
              for (const c of pickedLabels) {
                next.set(c.id, c);
                requested.current.add(c.id);
              }
              return next;
            });
          }
          onChange(ids);
          setPicking(false);
        }}
        initialSelectedIds={selectedIds}
        fieldDefinitions={fieldDefinitions}
        tags={tags}
        stages={stages}
        title={dialogTitle}
        description={dialogDescription}
        confirmLabel={confirmLabel}
      />
    </div>
  );
}
