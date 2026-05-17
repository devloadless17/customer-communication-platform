"use client";

import { useState } from "react";
import { X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@ccp/shared/utils";
import type { ContactFieldDefinition } from "@ccp/shared/types";

export interface FieldFilter {
  key: string;
  value: string;
}

export function FieldFilterRow({
  fieldDefinitions,
  value,
  onChange,
}: {
  fieldDefinitions: ContactFieldDefinition[];
  value: FieldFilter | null;
  onChange: (next: FieldFilter | null) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  function startEditing(key: string) {
    setOpenKey(key);
    setDraft(value?.key === key ? value.value : "");
  }

  function commit() {
    if (!openKey) return;
    const trimmed = draft.trim();
    onChange(trimmed ? { key: openKey, value: trimmed } : null);
    setOpenKey(null);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">Filter:</span>
      {fieldDefinitions.map((def) => {
        const active = value?.key === def.key;
        if (openKey === def.key) {
          return (
            <Input
              key={def.id}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setOpenKey(null);
                }
              }}
              placeholder={`${def.label} contains…`}
              autoFocus
              className="h-7 w-44 text-xs"
            />
          );
        }
        return (
          <button
            key={def.id}
            type="button"
            onClick={() => startEditing(def.key)}
            className={cn(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 transition",
              active
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-accent",
            )}
          >
            <span>{def.label}</span>
            {active && <span className="font-medium text-foreground">: {value?.value}</span>}
            {active && (
              <X
                className="size-3"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
