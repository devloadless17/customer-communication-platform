"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  ResetPasswordDialog,
  type ResetPasswordTarget,
} from "@/features/settings/reset-password-dialog";

/**
 * Platform-side "Reset password" action for a member of any org. The
 * superAdmin analog of the team-settings reset button — hits the cross-team
 * route on AdminTeamsController. Used inline in the member roster on the org
 * detail page (a client island in an otherwise-RSC page, same pattern as
 * TeamStatusControls).
 */
export function MemberResetPasswordButton({
  teamId,
  userId,
  name,
}: {
  teamId: string;
  userId: string;
  name: string;
}) {
  const [target, setTarget] = useState<ResetPasswordTarget | null>(null);

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        title="Set a new password for this member"
        onClick={() =>
          setTarget({
            name,
            endpoint: `/api/admin/teams/${teamId}/members/${userId}/reset-password`,
          })
        }
      >
        <KeyRound className="size-3.5" />
        Reset password
      </Button>
      <ResetPasswordDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}
