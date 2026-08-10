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

  // Decode ONCE, tolerantly. The 2026-08-01 fix removed decoding on the claim
  // that Next pre-decodes dynamic segments — it does not in this version
  // (campaign-analytics e2e proves "Spring Sale" arrives as `Spring%20Sale`),
  // so every campaign whose name contains a space 404'd from 08-01 until
  // this audit (2026-08-10). The try/catch keeps the 08-01 concern covered
  // in BOTH worlds: if a future Next version hands over a decoded "50% off",
  // decodeURIComponent throws on the bare % and we keep the raw value instead
  // of taking the page down.
  const { name: rawName } = await params;
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    // Already decoded (bare % in the value) — use as-is.
  }
  return <CampaignClient name={name} />;
}
