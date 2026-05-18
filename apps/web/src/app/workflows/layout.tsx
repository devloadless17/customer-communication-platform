import { SectionShell } from "@/components/layouts/section-shell";
import { WorkflowsSubSidebar } from "@/components/layouts/section-sub-sidebars";

/**
 * Workflows shell — minimal sub-sidebar (just the section header today);
 * the workflows list lives in /workflows itself.
 */
export default async function WorkflowsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SectionShell subSidebar={<WorkflowsSubSidebar />}>{children}</SectionShell>;
}
