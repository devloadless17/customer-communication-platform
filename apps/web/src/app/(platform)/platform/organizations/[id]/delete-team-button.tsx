"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch } from "@/lib/api/client-fetch";
import { apiErrorMessage } from "@ccp/shared/api/error-message";

/**
 * superAdmin-only inline delete button for a foreign team. Renders nothing
 * when `isOwnTeam` is true — admins delete their own org via /settings/members
 * so the operator's last action stays reversible (signout) rather than
 * self-destruct.
 */
export function DeleteTeamButton({
  organizationId,
  teamName,
  isOwnTeam,
}: {
  organizationId: string;
  teamName: string;
  isOwnTeam: boolean;
}) {
  const router = useRouter();
  // A plain busy flag, NOT useTransition. `run` awaits `confirm()`, and inside
  // an async transition that await is part of the in-flight action — React
  // holds it pending while the state update that opens the dialog is scheduled
  // within that same action, so the button spun forever and the confirm never
  // reached the user. Every other confirm-delete in the app uses this pattern.
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  if (isOwnTeam) return null;

  async function run() {
    setError(null);
    const ok = await confirm({
      title: `Delete ${teamName}?`,
      description:
        "This permanently removes the organization and EVERYTHING in it — contacts, conversations, messages, broadcasts, automations, every member account, every uploaded file. The WhatsApp connection is dropped. This cannot be undone.",
      confirmLabel: "Delete organization",
      destructive: true,
      // Blast radius = an entire tenant with no undo. Require typing the org
      // name so this can't be cleared with the same reflexive click as a tag
      // delete.
      requireText: teamName,
      requireTextLabel: (
        <>
          Type the organization name{" "}
          <span className="font-semibold text-foreground">{teamName}</span> to
          confirm
        </>
      ),
    });
    if (!ok) return;
    setPending(true);
    try {
      const res = await apiFetch(`/api/admin/organizations/${organizationId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setError(await apiErrorMessage(res, "Failed to delete organization"));
        return;
      }
      router.replace("/platform/organizations");
      // The list is an RSC page; replace() alone can serve it from the client
      // router cache still showing the org that was just deleted.
      router.refresh();
    } catch {
      // apiFetch THROWS on a 401 (and on any network failure) rather than
      // returning the response — unguarded, that left the spinner stuck on
      // forever with nothing shown, which is the bug this catch exists for.
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={run}
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        Delete organization
      </Button>
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-2xs text-destructive"
        >
          {error}
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
