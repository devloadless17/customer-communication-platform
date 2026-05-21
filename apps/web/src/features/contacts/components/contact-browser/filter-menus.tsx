"use client";

import { useMemo } from "react";
import { Check } from "lucide-react";

import { Input } from "@/components/ui/input";
import { tagColorClasses } from "@ccp/shared/utils/tag-colors";
import { cn } from "@ccp/shared/utils";
import type { ContactStage, ContactFieldDefinition } from "@ccp/shared/types";

import type {
  FieldFilter,
  SourceFilter,
  StageFilter,
  WindowFilter,
} from "./filter-types";

// ---------------------------------------------------------------------------
// Shared menu primitives
// ---------------------------------------------------------------------------

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </div>
  );
}

/** Single-select row with a leading dot/swatch slot and a trailing check. */
function RadioRow({
  active,
  onClick,
  leading,
  children,
}: {
  active: boolean;
  onClick: () => void;
  leading?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent/60",
        active && "bg-accent/40",
      )}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {active && <Check className="size-3.5 shrink-0 text-primary" />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Stage filter menu — vertical radio list: Any / <stages> / No stage
// ---------------------------------------------------------------------------

export function StageFilterMenu({
  stages,
  value,
  onChange,
}: {
  stages: ContactStage[];
  value: StageFilter;
  onChange: (next: StageFilter) => void;
}) {
  const sorted = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );
  return (
    <div className="w-56 py-1">
      <RadioRow active={value === "any"} onClick={() => onChange("any")}>
        Any stage
      </RadioRow>
      {sorted.map((s) => (
        <RadioRow
          key={s.id}
          active={value === s.id}
          onClick={() => onChange(s.id)}
          leading={
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                tagColorClasses(s.color).solid,
              )}
            />
          }
        >
          {s.name}
        </RadioRow>
      ))}
      <RadioRow
        active={value === "none"}
        onClick={() => onChange("none")}
        leading={<span className="size-2 shrink-0 rounded-full border border-border" />}
      >
        No stage
      </RadioRow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "More" menu — lower-frequency filters: Source, 24h window, custom fields
// ---------------------------------------------------------------------------

export function MoreFilterMenu({
  sourceFilter,
  onSourceChange,
  windowFilter,
  onWindowChange,
  fieldFilter,
  onFieldChange,
  fieldDefinitions,
}: {
  sourceFilter: SourceFilter;
  onSourceChange: (v: SourceFilter) => void;
  windowFilter: WindowFilter;
  /** Omit to hide the 24h-window section (e.g. surfaces that don't filter on it). */
  onWindowChange?: (v: WindowFilter) => void;
  fieldFilter: FieldFilter | null;
  onFieldChange: (v: FieldFilter | null) => void;
  fieldDefinitions: ContactFieldDefinition[];
}) {
  return (
    <div className="w-64 py-1">
      <MenuLabel>Source</MenuLabel>
      <RadioRow active={sourceFilter === "all"} onClick={() => onSourceChange("all")}>
        Everyone
      </RadioRow>
      <RadioRow
        active={sourceFilter === "inbound"}
        onClick={() => onSourceChange("inbound")}
      >
        Messaged me
      </RadioRow>
      <RadioRow
        active={sourceFilter === "manual"}
        onClick={() => onSourceChange("manual")}
      >
        Added by me
      </RadioRow>

      {onWindowChange && (
        <>
          <MenuLabel>24-hour window</MenuLabel>
          <RadioRow active={windowFilter === "any"} onClick={() => onWindowChange("any")}>
            Any
          </RadioRow>
          <RadioRow
            active={windowFilter === "open"}
            onClick={() => onWindowChange("open")}
            leading={<span className="size-2 shrink-0 rounded-full bg-emerald-500" />}
          >
            Open
          </RadioRow>
          <RadioRow
            active={windowFilter === "closed"}
            onClick={() => onWindowChange("closed")}
            leading={<span className="size-2 shrink-0 rounded-full bg-destructive" />}
          >
            Closed
          </RadioRow>
        </>
      )}

      {fieldDefinitions.length > 0 && (
        <>
          <MenuLabel>Custom fields</MenuLabel>
          <div className="space-y-1.5 px-3 pb-2 pt-1">
            {fieldDefinitions.map((def) => {
              const active = fieldFilter?.key === def.key;
              return (
                <Input
                  key={def.id}
                  value={active ? fieldFilter.value : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    onFieldChange(v ? { key: def.key, value: v } : null);
                  }}
                  placeholder={`${def.label} contains…`}
                  className="h-8 text-xs"
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
