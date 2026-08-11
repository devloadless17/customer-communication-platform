"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Shared "add a custom field" controls used by the contact panel and the
 * new-contact dialog. The component itself is parent-agnostic: it captures
 * a label + scope, then hands them back. The parent decides whether to
 * persist (PATCH/POST) or just stage in local state — that asymmetry is why
 * this is split as two callbacks instead of one.
 */
export function AddFieldRow({
  canManageFields,
  onAddPerContact,
  onAddTeamWide,
}: {
  canManageFields: boolean;
  onAddPerContact: (label: string) => Promise<void>;
  onAddTeamWide: (label: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<"contact" | "team">("contact");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
    setLabel("");
    setScope("contact");
  }, [open]);

  async function submit() {
    const trimmed = label.trim();
    if (!trimmed) return;
    setBusy(true);
    // finally, not bare awaits — a rejected fetch used to strand busy=true and
    // leave the Add-field row disabled forever (2026-08-11 stuck-pending audit).
    try {
      if (scope === "team" && canManageFields) {
        const ok = await onAddTeamWide(trimmed);
        if (ok) setOpen(false);
      } else {
        await onAddPerContact(trimmed);
        setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-3" />
        Add field
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-border bg-card p-2">
      <Input
        ref={inputRef}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
          }
        }}
        placeholder="Field name (e.g. Order ID)"
        disabled={busy}
        className="h-7 text-xs"
      />
      {canManageFields && (
        <div className="mt-2 flex gap-1 text-2xs">
          <ScopeChip
            active={scope === "contact"}
            onClick={() => setScope("contact")}
            label="Just this contact"
          />
          <ScopeChip
            active={scope === "team"}
            onClick={() => setScope("team")}
            label="All contacts"
          />
        </div>
      )}
      <div className="mt-2 flex justify-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => setOpen(false)}
          disabled={busy}
        >
          <X className="size-3" />
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={submit}
          disabled={busy || !label.trim()}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          Add
        </Button>
      </div>
    </div>
  );
}

function ScopeChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2 py-0.5 transition ${
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * Generate a per-contact key from a label, disambiguating against keys
 * already in use. Mirrors the server-side slugifyKey for team-wide fields
 * so per-contact and team-wide keys collide predictably (and we avoid
 * clashing with any team-wide key already on the contact).
 */
export function uniquePerContactKey(label: string, usedKeys: Iterable<string>): string {
  const used = new Set(usedKeys);
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "field";
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** "order_id" → "Order Id" — display label for per-contact one-off keys. */
export function prettifyKey(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}
