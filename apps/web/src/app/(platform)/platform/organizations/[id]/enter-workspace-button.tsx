"use client";

import { useState } from "react";
import { Loader2, LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { apiFetch } from "@/lib/api/client-fetch";
import { apiErrorMessage } from "@ccp/shared/api/error-message";

/**
 * OPERATOR MODE entry — the one audited door into a customer's workspace.
 *
 * Confirmed rather than one-click, and NOT because it is destructive: it is the
 * moment a platform operator stops looking at aggregates and starts looking at a
 * real tenant's inbox, and it writes a permanent `OperatorAccess` row saying so.
 * The dialog is what makes that a decision instead of a misclick, and it is
 * where the operator is reminded what is and isn't hidden.
 *
 * Hidden for the operator's OWN organization: they are a real member there and
 * reach it through the ordinary workspace switcher. Routing that through this
 * door would file audit rows about visiting themselves.
 */
export function EnterWorkspaceButton({
  workspaceId,
  workspaceName,
  orgName,
  isOwnOrg,
}: {
  workspaceId: string;
  workspaceName: string;
  orgName: string;
  isOwnOrg: boolean;
}) {
  // Plain busy flag, not useTransition — `run` awaits `confirm()`, and inside an
  // async transition that await never resolves (see the sibling delete button).
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  if (isOwnOrg) return null;

  async function run() {
    setError(null);
    const ok = await confirm({
      title: `Enter ${workspaceName}?`,
      description:
        `You'll open ${orgName}'s live workspace as an admin — their conversations, contacts and settings. ` +
        "This is recorded in the organization's operator-access log. Viewing leaves no trace for their " +
        "team: no unread is cleared, no read receipts are sent, and you won't appear online, typing, or " +
        "as a viewer. Anything you SEND or CHANGE is a normal, visible action.",
      confirmLabel: "Enter workspace",
    });
    if (!ok) return;
    setPending(true);
    try {
      const res = await apiFetch("/api/admin/operator-access", {
        // `apiFetch` sets no content-type of its own; without this Express's
        // json parser skips the body and Zod rejects the empty object.
        headers: { "content-type": "application/json" },
        method: "POST",
        body: JSON.stringify({ workspaceId }),
      });
      if (!res.ok) {
        setError(await apiErrorMessage(res, "Couldn't enter workspace"));
        return;
      }
      // FULL navigation, never router.push: the active workspace is the tenant
      // scope for every RSC query AND for the Socket.io room this client is
      // joined to. A soft nav would leave the socket attached to the previous
      // `ws:` room — the tenant's inbox rendering while another workspace's
      // frames arrive. Same reasoning as the workspace switcher.
      window.location.assign("/inbox");
    } catch {
      // apiFetch throws on 401 / network failure rather than returning a
      // response; unguarded that leaves the spinner up with nothing explained.
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={run}>
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <LogIn className="size-3.5" />
        )}
        Enter workspace
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
