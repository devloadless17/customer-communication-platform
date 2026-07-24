"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch } from "@/lib/api/client-fetch";
import { apiErrorMessage } from "@ccp/shared/api/error-message";

/**
 * Delete an organisation that has NO workspaces, from the list row.
 *
 * Rows normally delegate to the detail page for this, but that page is keyed by
 * a workspace id — so an org with none is reachable from nowhere. That state is
 * real: social signup creates the Organization before the User (the FK is
 * required with no default), so a failed user insert leaves a `pending` org
 * that shows up here, cannot be opened, and keeps holding its founder's
 * globally-unique email.
 *
 * Deliberately NOT the same copy as the detail page's button: an org with no
 * workspaces has no contacts, conversations or messages to warn about, and
 * listing them would be a scarier — and untrue — description of what is being
 * removed. No type-to-confirm for the same reason; there is nothing to lose.
 */
export function DeleteOrgButton({
  organizationId,
  orgName,
}: {
  organizationId: string;
  orgName: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  async function run() {
    setError(null);
    const ok = await confirm({
      title: `Delete ${orgName}?`,
      description:
        "This organization has no workspaces — it's left over from a sign-up that didn't finish. Deleting it removes the organization and any member accounts on it, freeing their email addresses to sign up again.",
      confirmLabel: "Delete organization",
      destructive: true,
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
      router.refresh();
    } catch {
      // apiFetch throws on 401 and on any network failure rather than returning
      // the response; without this the button would spin forever in silence.
      setError("Couldn't reach the server. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={run}
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Trash2 className="size-3.5" />
        )}
        Delete
      </Button>
      {error && <span className="text-3xs text-destructive">{error}</span>}
      {confirmDialog}
    </div>
  );
}
