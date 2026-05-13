import { redirect } from "next/navigation";

import { getSession } from "@/lib/current-user";
import { canManageStages } from "@/lib/permissions";
import { listContactStages } from "@/lib/queries";
import { db } from "@/lib/db";

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
  const { user, teamId } = await getSession();
  if (!canManageStages(user.role)) {
    redirect("/settings/account");
  }

  const [stages, contactCounts] = await Promise.all([
    listContactStages(teamId),
    db.contact.groupBy({
      by: ["stageId"],
      where: { teamId },
      _count: { _all: true },
    }),
  ]);

  // Roll up the grouped counts into a plain map the client can index by id.
  // `null` group is contacts that have no stage at all — surfaced on the
  // page so the admin can SEE them and re-park them via /contacts.
  const countsByStageId: Record<string, number> = {};
  let unassignedCount = 0;
  for (const row of contactCounts) {
    if (row.stageId === null) unassignedCount = row._count._all;
    else countsByStageId[row.stageId] = row._count._all;
  }

  return (
    <StagesSettings
      initialStages={stages}
      countsByStageId={countsByStageId}
      unassignedCount={unassignedCount}
    />
  );
}
