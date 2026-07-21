import { redirect } from "next/navigation";

import { canManageUsers } from "@ccp/shared/auth/permissions";
import { getSession } from "@/lib/auth/current-user";

import { AssignmentSettings } from "@/features/settings/assignment/assignment-settings";

export const metadata = { title: "Assignment · Settings" };
export const dynamic = "force-dynamic";

/**
 * Conversation routing. Who gets a new chat, on what rule, with what limits —
 * and when routing runs automatically.
 *
 * Admin-only: the page exposes every member's live workload, and routing
 * decides how paid work is distributed. Same gate as Role permissions.
 */
export default async function AssignmentSettingsPage() {
  const { user } = await getSession();
  if (!canManageUsers(user.role)) redirect("/settings/team");

  return <AssignmentSettings />;
}
