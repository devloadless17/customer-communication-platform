"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, RotateCcw, ShieldX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client-fetch";
import type { TeamStatus } from "@ccp/shared/types";

/**
 * Shared mutation hook for the org-approval controls. PATCHes the status, then
 * `router.refresh()` re-runs the RSC so the badge + analytics reflect the
 * change. The server also busts the target org's session cache, so the change
 * takes effect for that org on its next request — not after the 15s TTL.
 */
function useSetTeamStatus(teamId: string) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function setStatus(
    status: "active" | "suspended",
    reason?: string,
    onDone?: () => void,
  ) {
    setError(null);
    startTransition(async () => {
      const res = await apiFetch(`/api/admin/teams/${teamId}/status`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reason ? { status, reason } : { status }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Failed to update status");
        return;
      }
      onDone?.();
      router.refresh();
    });
  }

  return { setStatus, pending, error };
}

/**
 * One-click "Approve" for a pending org. Used inline in the Organizations list
 * (the approval queue) so the common action doesn't need a detail-page trip.
 */
export function QuickApproveButton({ teamId }: { teamId: string }) {
  const { setStatus, pending, error } = useSetTeamStatus(teamId);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" disabled={pending} onClick={() => setStatus("active")}>
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <CheckCircle2 className="size-3.5" />
        )}
        Approve
      </Button>
      {error && <span className="text-3xs text-destructive">{error}</span>}
    </div>
  );
}

/**
 * Full status controls for the org detail page: Approve (pending → active),
 * Suspend (active → suspended, with an optional reason shown on the org's gate
 * screen), and Reactivate (suspended → active). Hidden for the operator's own
 * org — that's managed from Settings, mirroring the delete button's guard.
 */
export function TeamStatusControls({
  teamId,
  status,
  isOwnTeam,
}: {
  teamId: string;
  status: TeamStatus;
  isOwnTeam: boolean;
}) {
  const { setStatus, pending, error } = useSetTeamStatus(teamId);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [reason, setReason] = useState("");

  if (isOwnTeam) {
    return (
      <p className="text-[12px] text-muted-foreground">
        This is your own organization.
      </p>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {status === "pending" && (
          <Button disabled={pending} onClick={() => setStatus("active")}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            Approve organization
          </Button>
        )}
        {status === "active" && (
          <Button
            variant="outline"
            disabled={pending}
            className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => setSuspendOpen((v) => !v)}
          >
            <ShieldX className="size-4" />
            Suspend access
          </Button>
        )}
        {status === "suspended" && (
          <Button disabled={pending} onClick={() => setStatus("active")}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCcw className="size-4" />
            )}
            Reactivate
          </Button>
        )}
      </div>

      {suspendOpen && status === "active" && (
        <div className="flex w-full max-w-sm flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
          <label htmlFor="suspend-reason" className="text-[12px] font-medium">
            Reason (optional — shown to the organization)
          </label>
          <textarea
            id="suspend-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="e.g. Payment overdue — contact billing to restore."
            className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSuspendOpen(false);
                setReason("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() =>
                setStatus("suspended", reason.trim() || undefined, () => {
                  setSuspendOpen(false);
                  setReason("");
                })
              }
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ShieldX className="size-3.5" />
              )}
              Confirm suspend
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-2xs text-destructive"
        >
          {error}
        </div>
      )}
    </div>
  );
}
