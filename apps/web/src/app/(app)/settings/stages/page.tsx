import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";
import { getStageContactCounts, listContactStages } from "@/lib/api/queries";

import { StagesSettings } from "./stages-settings";

export const metadata = { title: "Stages · Settings" };
export const dynamic = "force-dynamic";

/**
 * Customer-lifecycle stage manager.
 *
 * Read-side is open to anyone signed in (the underlying API returns the
 * catalog for everyone — agents need it to switch a contact's stage). The
 * MANAGEMENT page is admin/manager-only because it adds/removes/renames
 * the catalog itself; agents seeing it without permission would just be
 * confused. Redirect to /settings/account when gated.
 */
export default async function StagesSettingsPage() {
  const { permissions } = await getSession();
  if (!permissions["stages:manage"]) {
    redirect("/settings/account");
  }

  const [stages, counts] = await Promise.all([
    listContactStages(),
    getStageContactCounts(),
  ]);

  return (
    <StagesSettings
      initialStages={stages}
      countsByStageId={counts.countsByStageId}
      unassignedCount={counts.unassignedCount}
    />
  );
}
