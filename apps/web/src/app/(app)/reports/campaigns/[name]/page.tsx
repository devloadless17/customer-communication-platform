import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";

import { CampaignClient } from "@/features/reports/campaign-client";

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

  // NOT decoded again: Next already decodes dynamic segments before handing
  // them over, so a second pass mangles any campaign whose name contains a
  // percent sign ("50% off" → `%20off` → a URIError that takes the page down).
  const { name } = await params;
  return <CampaignClient name={name} />;
}
