"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Pencil, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api/client-fetch";
import { apiErrorMessage } from "@ccp/shared/api/error-message";

/**
 * Inline editor for a super-admin-controlled limit on the platform org-detail
 * page. Shows "<used> / <max> <noun>s" and, on click, a number input to raise
 * or lower the cap, then `router.refresh()` so the figure re-renders.
 *
 * Generic over BOTH caps rather than duplicated per limit — the seat cap
 * (per workspace) and the workspace cap (per organisation) differ only in
 * their endpoint, body key and noun, and two near-identical files would drift
 * the first time one gained a validation rule.
 *
 * Lowering below what is already in use is ALLOWED on purpose: existing
 * members and workspaces are grandfathered and the cap only blocks the NEXT
 * one, so we surface a soft note instead of blocking the save. Nothing is ever
 * deleted to satisfy a lowered limit.
 */
export function LimitControl({
  workspaceId,
  max,
  used,
  endpoint,
  bodyKey,
  noun,
  label,
  hardMax = 1000,
}: {
  workspaceId: string;
  max: number;
  used: number;
  /** e.g. "max-members" → PATCH /api/admin/teams/:id/max-members */
  endpoint: string;
  /** e.g. "maxMembers" — the PATCH body key the endpoint expects. */
  bodyKey: string;
  /** Singular noun for the readout: "member", "workspace". */
  noun: string;
  /** Button/field label: "Limit", "Max members". */
  label: string;
  hardMax?: number;
}) {
  const maxMembers = max;
  const activeMembers = used;
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(maxMembers));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    const next = Number(value);
    if (!Number.isInteger(next) || next < 1 || next > hardMax) {
      setError(`Enter a whole number between 1 and ${hardMax}.`);
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await apiFetch(`/api/admin/teams/${workspaceId}/${endpoint}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [bodyKey]: next }),
      });
      if (!res.ok) {
        setError(await apiErrorMessage(res, `Failed to update the ${noun} limit.`));
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
          / {maxMembers} {noun}{maxMembers === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-3xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          <Pencil className="size-2.5" />
          {label}
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
        <span className="text-2xs text-muted-foreground">Max {noun}s</span>
        <Input
          type="number"
          min={1}
          max={hardMax}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancel();
          }}
          autoFocus
          className="h-7 w-16 text-sm"
          aria-label={`Maximum ${noun}s`}
        />
        <Button
          size="icon"
          className="size-7"
          disabled={pending}
          onClick={save}
          aria-label={`Save ${noun} limit`}
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
          {activeMembers} {noun}{activeMembers === 1 ? "" : "s"} already — existing stay, no new ones.
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
