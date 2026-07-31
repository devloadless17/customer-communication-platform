import { redirect } from "next/navigation";

import { canManageUsers } from "@ccp/shared/auth/permissions";
import { getSession } from "@/lib/auth/current-user";

import { AssignmentSettings } from "@/features/settings/assignment/assignment-settings";

export const metadata = { title: "Teams & routing · Settings" };
export const dynamic = "force-dynamic";

/**
 * Teams and conversation routing. Who is on which team, who gets a new chat,
 * on what rule, with what limits — and when routing runs automatically.
 *
 * A "team" here is an `Team`: a named group of members with a
 * strategy, weights and capacity. That row already IS the routable group, so it
 * is surfaced under the name people use rather than duplicated into a second
 * entity that could disagree with it about who is on the team.
 *
 * Admin-only: the page exposes every member's live workload, and routing
 * decides how paid work is distributed. Same gate as Role permissions.
 */
export default async function AssignmentSettingsPage() {
  const { user } = await getSession();
  if (!canManageUsers(user.role)) redirect("/settings/members");

  return <AssignmentSettings />;
}
