import { BroadcastsSubSidebar } from "@/components/layouts/section-sub-sidebars";
import { SectionShell } from "@/components/layouts/section-shell";

/**
 * Broadcasts shell. The same sub-sidebar (Broadcasts / Audience groups /
 * Templates) is reused by /templates so the "outreach" surface feels unified.
 */
export default async function BroadcastsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SectionShell subSidebar={<BroadcastsSubSidebar />}>{children}</SectionShell>;
}
