"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";

/**
 * Inline editor for an org's member cap (super-admin only — lives on the
 * platform org-detail page). Shows "<active> / <max> members" and, on click,
 * a small number input to raise/lower the cap. PATCHes
 * /api/admin/teams/:id/max-members then `router.refresh()` so the figure
 * re-renders. Lowering below the current active count is allowed — existing
 * members are grandfathered, the cap only blocks NEW joins — so we surface a
 * soft note rather than blocking the save.
 */
export function MaxMembersControl({
  teamId,
  maxMembers,
  activeMembers,
}: {
  teamId: string;
  maxMembers: number;
  activeMembers: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(maxMembers));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    const next = Number(value);
    if (!Number.isInteger(next) || next < 1 || next > 1000) {
      setError("Enter a whole number between 1 and 1000.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await apiFetch(`/api/admin/teams/${teamId}/max-members`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxMembers: next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to update the member limit.");
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  function cancel() {
    setValue(String(maxMembers));
    setError(null);
    setEditing(false);
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2 text-2xs text-muted-foreground">
        <span>
          <span className="font-medium tabular-nums text-foreground">
            {activeMembers}
          </span>{" "}
          / {maxMembers} member{maxMembers === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-3xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Pencil className="size-2.5" />
          Limit
        </button>
      </div>
    );
  }

  const next = Number(value);
  const willStrandExisting =
    Number.isInteger(next) && next >= 1 && next < activeMembers;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <span className="text-2xs text-muted-foreground">Max members</span>
        <Input
          type="number"
          min={1}
          max={1000}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancel();
          }}
          autoFocus
          className="h-7 w-16 text-sm"
          aria-label="Maximum members"
        />
        <Button
          size="icon"
          className="size-7"
          disabled={pending}
          onClick={save}
          aria-label="Save member limit"
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={pending}
          onClick={cancel}
          aria-label="Cancel"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {willStrandExisting && (
        <span className="text-3xs text-warning-fg">
          {activeMembers} members already — existing stay, no new joins.
        </span>
      )}
      {error && (
        <span className="text-3xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
