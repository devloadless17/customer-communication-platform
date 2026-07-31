import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";

import { CampaignsClient } from "@/features/reports/campaigns-client";

export const metadata = { title: "Campaigns" };
export const dynamic = "force-dynamic";

/**
 * Campaign index — every campaign name used across the workspace's broadcasts.
 *
 * Same `teamActivity:view` gate as the reports dashboard it lives under: a
 * campaign rollup is aggregate performance data, which is the exact thing that
 * capability governs. The endpoint enforces it too; this redirect just spares a
 * 403 for someone who reaches the URL directly.
 */
export default async function CampaignsPage() {
  const { permissions } = await getSession();
  if (!permissions["teamActivity:view"]) redirect("/inbox");

  return <CampaignsClient />;
}
