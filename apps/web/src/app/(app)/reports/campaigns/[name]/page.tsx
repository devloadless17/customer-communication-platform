import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";

import { CampaignClient } from "./campaign-client";

export const metadata = { title: "Campaign" };
export const dynamic = "force-dynamic";

/**
 * One campaign's rollup. `name` IS the campaign name (the join key across
 * broadcasts), URL-encoded — it can contain spaces and punctuation, so it is
 * decoded here rather than trusted raw.
 */
export default async function CampaignPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { permissions } = await getSession();
  if (!permissions["teamActivity:view"]) redirect("/inbox");

  const { name } = await params;
  return <CampaignClient name={decodeURIComponent(name)} />;
}
