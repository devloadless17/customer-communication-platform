"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch } from "@/lib/api/client-fetch";

/**
 * superAdmin-only inline delete button for a foreign team. Renders nothing
 * when `isOwnTeam` is true — admins delete their own org via /settings/team
 * so the operator's last action stays reversible (signout) rather than
 * self-destruct.
 */
export function DeleteTeamButton({
  workspaceId,
  teamName,
  isOwnTeam,
}: {
  workspaceId: string;
  teamName: string;
  isOwnTeam: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
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
    const res = await apiFetch(`/api/admin/teams/${workspaceId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Failed to delete organization");
      return;
    }
    router.replace("/platform/organizations");
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => startTransition(run)}
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
