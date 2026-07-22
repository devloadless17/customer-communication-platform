import { listMessageFlagDefinitions } from "@/lib/api/queries";

import { SectionShell } from "@/components/layouts/section-shell";
import { FlagsSubSidebar } from "@/components/layouts/flags-sub-sidebar";

/**
 * Flagged shell.
 *
 * Like /tickets, this section shipped without a layout — it rendered bare
 * inside the app shell with no left rail while every sibling section had one.
 *
 * The definition catalog is loaded HERE, not in the page: the sidebar needs it
 * on first paint, and the layout survives navigation between queue views so it
 * isn't refetched on every filter change.
 */
export default async function FlagsLayout({ children }: { children: React.ReactNode }) {
  const definitions = await listMessageFlagDefinitions();
  return (
    <SectionShell subSidebar={<FlagsSubSidebar definitions={definitions} />}>
      {children}
    </SectionShell>
  );
}
