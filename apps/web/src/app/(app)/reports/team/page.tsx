import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { getTeamLive, listTeamMembers } from "@/lib/api/queries";

import { TeamClient } from "@/features/reports/team-client";

export const metadata = { title: "Team · Reports" };
export const dynamic = "force-dynamic";

/**
 * Team performance report — the per-agent lens on the workspace (the overview
 * is the per-channel/per-day lens). Gated by the same `teamActivity:view`
 * capability as the rest of /reports; the endpoints enforce it too, this
 * redirect just spares a 403.
 *
 * The ranged report is fetched client-side (browser-midnight daily buckets,
 * same as the overview). The ROSTER and the live "now" seed come from the RSC
 * render so the strip's first paint carries real names, avatars and counts.
 */
export default async function TeamReportPage() {
  const { permissions, workspaceId, user } = await getSession();
  if (!permissions["teamActivity:view"]) redirect("/inbox");

  const [members, initialLive] = await Promise.all([listTeamMembers(), getTeamLive()]);

  return (
    <TeamClient
      workspaceId={workspaceId}
      currentUserId={user.id}
      members={members.map((m) => ({
        userId: m.id,
        name: m.name,
        avatarUrl: m.avatarUrl ?? null,
        isActive: m.isActive,
      }))}
      initialLive={initialLive}
    />
  );
}
