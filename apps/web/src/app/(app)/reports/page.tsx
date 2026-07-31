import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/current-user";

import { ReportsClient } from "@/features/reports/reports-client";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

/**
 * Workspace performance dashboard. Gated by the `teamActivity:view` capability
 * (same switch as the team-activity settings page — one admin-configurable
 * control governs both "how is the team performing" surfaces). The endpoint
 * enforces it too; this redirect just spares a 403 for users who reach the
 * URL without it.
 *
 * Data is fetched client-side (not RSC) because the daily buckets must flip
 * at the BROWSER's midnight — the server doesn't know the agent's timezone
 * until the client sends it.
 */
export default async function ReportsPage() {
  const { permissions } = await getSession();
  if (!permissions["teamActivity:view"]) redirect("/inbox");

  return <ReportsClient />;
}
