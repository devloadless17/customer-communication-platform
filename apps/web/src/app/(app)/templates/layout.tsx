import { BroadcastsSubSidebar } from "@/components/layouts/section-sub-sidebars";
import { SectionShell } from "@/components/layouts/section-shell";

/**
 * Templates lives under the "Outreach" surface — same sub-sidebar shape as
 * /broadcasts so navigating between Broadcasts, Audience groups, and
 * Templates doesn't shift the chrome.
 */
export default async function TemplatesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SectionShell subSidebar={<BroadcastsSubSidebar />} capContentWidth>
      {children}
    </SectionShell>
  );
}
