import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { getSession } from "@/lib/auth/current-user";
import { getCurrentTeam, listTeamMembers } from "@/lib/api/queries";
import { canManageUsers } from "@ccp/shared/auth/permissions";
import { PageHeader } from "@/components/layouts/page-header";

import { AiAutopilotToggle } from "@/features/settings/integrations/components/ai-autopilot-toggle";

export const metadata = { title: "AI Autopilot" };
export const dynamic = "force-dynamic";

/**
 * Dedicated AI Autopilot settings page — the on/off opt-in plus handoff
 * behavior and first-touch greeting. Lifted out of the Integrations landing
 * page into its own section (linked from the tile grid) so the surface stays
 * organized. Admin-only.
 */
export default async function AiAutopilotPage() {
  const { user } = await getSession();
  if (!canManageUsers(user.role)) {
    redirect("/settings/account");
  }

  const [team, members] = await Promise.all([getCurrentTeam(), listTeamMembers()]);

  return (
    <div>
      <Link
        href="/settings/integrations"
        className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3" />
        Back to Integrations
      </Link>
      <PageHeader
        title="AI Autopilot"
        description="Let an external AI flow (e.g. n8n) auto-reply to customers, and control what happens when a customer asks for a human or starts a new session."
        className="mb-8"
      />

      <AiAutopilotToggle
        initial={{
          enabled: team.aiAutopilotEnabled,
          handoffAction: team.aiHandoffAction,
          handoffAssigneeId: team.aiHandoffAssigneeId,
          firstTouchGreeter: team.firstTouchGreeter,
        }}
        members={members
          .filter((m) => m.isActive)
          .map((m) => ({ id: m.id, name: m.name, email: m.email }))}
      />
    </div>
  );
}
